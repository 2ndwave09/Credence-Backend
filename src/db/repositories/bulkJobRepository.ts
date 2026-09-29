import type { Pool, PoolClient } from 'pg'
import { getBulkWorkerPollQuery } from '../../jobs/scheduler.js'

export type BulkJobRow = {
  id: string
  org_id: string
  size: number
  payload: string
  status: string
  created_at: Date
  updated_at: Date
}

/**
 * Error thrown when a bulk job state transition is rejected by an invariant.
 * Callers can rely on `code` for programmatic handling without parsing messages.
 */
export class BulkJobStateError extends Error {
  readonly code: string
  constructor(code: string, message: string) {
    super(message)
    this.name = 'BulkJobStateError'
    this.code = code
  }
}

/**
 * Allowed status transitions for a bulk job.
 * Invariant: a job may only move forward through this graph. Terminal states
 * (`succeeded`, `failed`, `cancelled`) cannot transition further, which
 * prevents late/duplicate worker callbacks from resurrecting finished jobs.
 */
const ALLOWED_TRANSITIONS: Record<string, ReadonlyArray<string>> = {
  pending: ['running', 'cancelled'],
  running: ['succeeded', 'failed', 'cancelled'],
  succeeded: [],
  failed: [],
  cancelled: [],
}

const TERMINAL_STATUSES = new Set(['succeeded', 'failed', 'cancelled'])

export class BulkJobRepository {
  constructor(private readonly db: Pool | PoolClient) {}

  private map(row: any): BulkJobRow {
    return {
      id: row.id,
      org_id: row.org_id,
      size: Number(row.size),
      payload: row.payload,
      status: row.status,
      created_at: row.created_at,
      updated_at: row.updated_at,
    }
  }

  /**
   * Create a new bulk job in the `pending` state.
   * Boundary: `size` must be a positive safe integer; `orgId` must be non-empty.
   */
  async create(orgId: string, size: number, payload: Record<string, unknown>): Promise<BulkJobRow> {
    if (!orgId || typeof orgId !== 'string') {
      throw new BulkJobStateError('INVALID_ORG_ID', 'orgId must be a non-empty string')
    }
    if (!Number.isSafeInteger(size) || size <= 0) {
      throw new BulkJobStateError('INVALID_SIZE', 'size must be a positive safe integer')
    }
    const { rows } = await this.db.query(
      `INSERT INTO bulk_jobs (org_id, size, payload, status)
       VALUES ($1, $2, $3, $4)
       RETURNING id, org_id, size, payload, status, created_at, updated_at`,
      [orgId, size, JSON.stringify(payload), 'pending']
    )
    return this.map(rows[0])
  }

  /**
   * Atomically claim the next queued job using WFQ ordering.
   *
   * Concurrency: the CTE + UPDATE ... WHERE id IN (SELECT id FROM candidate)
   * is a single statement, so two workers cannot claim the same row. If no
   * candidate exists, returns null (normal empty-queue case, not an error).
   */
  async claimNextQueuedWfq(): Promise<BulkJobRow | null> {
    // Build the selection CTE using helper SQL, then atomically update
    const pollSql = getBulkWorkerPollQuery('bulk_jobs', 'org_usage_daily')
    const sql = `WITH candidate AS (${pollSql})
      UPDATE bulk_jobs
      SET status = 'running', updated_at = NOW()
      WHERE id IN (SELECT id FROM candidate)
      RETURNING id, org_id, size, payload, status, created_at, updated_at`

    const { rows } = await this.db.query(sql)
    return rows.length ? this.map(rows[0]) : null
  }

  /**
   * Update the status of a bulk job, enforcing the transition invariant.
   *
   * Recovery semantics:
   * - If the job does not exist, returns null (caller decides how to react).
   * - If the transition is not allowed (e.g. succeeded -> running), throws
   *   `BulkJobStateError` with code `INVALID_TRANSITION`. This makes retries
   *   and duplicate worker callbacks fail loudly instead of silently
   *   corrupting state.
   * - The UPDATE is guarded by the current status in the WHERE clause so a
   *   concurrent transition cannot be overwritten (compare-and-swap).
   */
  async updateStatus(id: string, status: string, metadata?: Record<string, unknown>): Promise<BulkJobRow | null> {
    if (!id || typeof id !== 'string') {
      throw new BulkJobStateError('INVALID_ID', 'id must be a non-empty string')
    }
    if (!status || typeof status !== 'string') {
      throw new BulkJobStateError('INVALID_STATUS', 'status must be a non-empty string')
    }

    const current = await this.findById(id)
    if (!current) return null

    if (current.status === status) {
      // Idempotent no-op: same status is a safe retry, not an error.
      return current
    }

    const allowed = ALLOWED_TRANSITIONS[current.status] ?? []
    if (!allowed.includes(status)) {
      throw new BulkJobStateError(
        'INVALID_TRANSITION',
        `cannot transition bulk job ${id} from ${current.status} to ${status}`
      )
    }

    const { rows } = await this.db.query(
      `UPDATE bulk_jobs
       SET status = $2, payload = COALESCE($3::jsonb, payload), updated_at = NOW()
       WHERE id = $1 AND status = $4
       RETURNING id, org_id, size, payload, status, created_at, updated_at`,
      [id, status, metadata ? JSON.stringify(metadata) : null, current.status]
    )

    if (!rows.length) {
      // Lost the compare-and-swap race: another writer changed status first.
      throw new BulkJobStateError(
        'CONCURRENT_TRANSITION',
        `bulk job ${id} was modified concurrently`
      )
    }

    return this.map(rows[0])
  }

  /**
   * Look up a bulk job by id. Returns null when not found (normal case).
   */
  async findById(id: string): Promise<BulkJobRow | null> {
    const { rows } = await this.db.query(
      `SELECT id, org_id, size, payload, status, created_at, updated_at FROM bulk_jobs WHERE id = $1`,
      [id]
    )
    return rows.length ? this.map(rows[0]) : null
  }

  /**
   * True when the job is in a terminal state and must not be transitioned.
   * Exposed for callers that need to short-circuit retries without a DB write.
   */
  isTerminal(status: string): boolean {
    return TERMINAL_STATUSES.has(status)
  }
}

export default BulkJobRepository
