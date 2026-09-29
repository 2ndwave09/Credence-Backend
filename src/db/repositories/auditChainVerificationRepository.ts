import type { Queryable } from './queryable.js'
import type { AuditChainVerificationState } from '../../services/audit/types.js'
import { getTenantId } from '../../utils/tenantContext.js'

export interface AuditChainVerificationRepository {
  getStatus(): Promise<AuditChainVerificationState | null>
  saveStatus(state: AuditChainVerificationState): Promise<AuditChainVerificationState>
  clear(): Promise<void>
}

type StatusRow = {
  last_verified_height: string | number
  verified_at: Date | string | null
  status: string
  first_break_seq: string | number | null
  violation_count: number
  rows_checked: number
}

const MAX_SAFE_HEIGHT = Number.MAX_SAFE_INTEGER

function assertSafeInteger(value: number, field: string): number {
  if (!Number.isInteger(value) || value < 0 || value > MAX_SAFE_HEIGHT) {
    throw new Error(`Invalid ${fiel}: ${value}`)
  }
  return value
}

function mapRow(row: StatusRow): AuditChainVerificationState {
  const lastVerifiedHeight = Number(row.last_verified_height)
  if (!Number.isSafeInteger(lastVerifiedHeight) || lastVerifiedHeight < 0) {
    throw new Error(`Invalid last_verified_height returned from database`)
  }

  const firstBreakSeq =
    row.first_break_seq !== null ? Number(row.first_break_seq) : null
  if (firstBreakSeq !== null && (!Number.isSafeInteger(firstBreakSeq) || firstBreakSeq < 0)) {
    throw new Error('Invalid first_break_seq returned from database')
  }

  const violationCount = Number(row.violation_count)
  if (!Number.isSafeInteger(violationCount) || violationCount < 0) {
    throw new Error('Invalid violation_count returned from database')
  }

  const rowsChecked = Number(row.rows_checked)
  if (!Number.isSafeInteger(rowsChecked) || rowsChecked < 0) {
    throw new Error('Invalid rows_checked returned from database')
  }

  return {
    lastVerifiedHeight,
    verifiedAt: row.verified_at
      ? row.verified_at instanceof Date
        ? row.verified_at.toISOString()
        : String(row.verified_at)
      : null,
    status: row.status as AuditChainVerificationState['status'],
    firstBreakSeq,
    violationCount,
    rowsChecked,
  }
}

function cloneState(state: AuditChainVerificationState): AuditChainVerificationState {
  return {
    lastVerifiedHeight: state.lastVerifiedHeight,
    verifiedAt: state.verifiedAt,
    status: state.status,
    firstBreakSeq: state.firstBreakSeq,
    violationCount: state.violationCount,
    rowsChecked: state.rowsChecked,
  }
}

function validateState(state: AuditChainVerificationState): void {
  if (!state || typeof state !== 'object') {
    throw new Error('Invalid audit chain verification state')
  }

  assertSafeInteger(state.lastVerifiedHeight, 'lastVerifiedHeight')

  if (state.firstBreakSeq !== null && state.firstBreakSeq !== undefined) {
    assertSafeInteger(state.firstBreakSeq, 'firstBreakSeq')
  }

  if (state.violationCount !== undefined) {
    assertSafeInteger(state.violationCount, 'violationCount')
  }

  if (state.rowsChecked !== undefined) {
    assertSafeInteger(state.rowsChecked, 'rowsChecked')
  }

  if (state.verifiedAt !== null && state.verifiedAt !== undefined) {
    const parsed = new Date(state.verifiedAt)
    if (Number.isNaN(parsed.getTime())) {
      throw new Error(`Invalid verifiedAt: ${state.verifiedAt}`)
    }
  }

  if (state.status !== 'never_run' && state.verifiedAt === null) {
    throw new Error('verifiedAt is required unless status is never_run')
  }
}

export class PostgresAuditChainVerificationRepository implements AuditChainVerificationRepository {
  constructor(private readonly db: Queryable) {}

  async getStatus(): Promise<AuditChainVerificationState | null> {
    const tenantId = getTenantId()
    if (!tenantId) {
      throw new Error('Missing tenant context')
    }
    const result = await this.db.query<StatusRow>(
      `
      SELECT
        last_verified_height,
        verified_at,
        status,
        first_break_seq,
        violation_count,
        rows_checked
      FROM audit_chain_verification_status
      WHERE id = $1
      `,
      [tenantId],
    )

    if (result.rows.length === 0) {
      return null
    }

    const state = mapRow(result.rows[0])
    return state.status === 'never_run' && state.verifiedAt === null ? null : state
  }

  async saveStatus(state: AuditChainVerificationState): Promise<AuditChainVerificationState> {
    const tenantId = getTenantId()
    if (!tenantId) {
      throw new Error('Missing tenant context')
    }
    validateState(state)
    const result = await this.db.query<StatusRow>(
      `
      INSERT INTO audit_chain_verification_status (
        id,
        last_verified_height,
        verified_at,
        status,
        first_break_seq,
        violation_count,
        rows_checked,
        updated_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())
      ON CONFLICT (id) DO UPDATE SET
        last_verified_height = EXCLUDED.last_verified_height,
        verified_at = EXCLUDED.verified_at,
        status = EXCLUDED.status,
        first_break_seq = EXCLUDED.first_break_seq,
        violation_count = EXCLUDED.violation_count,
        rows_checked = EXCLUDED.rows_checked,
        updated_at = NOW()
      RETURNING
        last_verified_height,
        verified_at,
        status,
        first_break_seq,
        violation_count,
        rows_checked
      `,
      [
        tenantId,
        state.lastVerifiedHeight,
        state.verifiedAt,
        state.status,
        state.firstBreakSeq ?? null,
        state.violationCount ?? 0,
        state.rowsChecked ?? 0,
      ],
    )

    return mapRow(result.rows[0])
  }

  async clear(): Promise<void> {
    const tenantId = getTenantId()
    if (!tenantId) {
      throw new Error('Missing tenant context')
    }
    await this.db.query(
      `
      UPDATE audit_chain_verification_status
      SET
        last_verified_height = 0,
        verified_at = NULL,
        status = 'never_run',
        first_break_seq = NULL,
        violation_count = 0,
        rows_checked = 0,
        updated_at = NOW()
      WHERE id = $1
      `,
      [tenantId],
    )
  }
}

export class InMemoryAuditChainVerificationRepository implements AuditChainVerificationRepository {
  private readonly states = new Map<string, AuditChainVerificationState>()

  async getStatus(): Promise<AuditChainVerificationState | null> {
    const tenantId = getTenantId()
    if (!tenantId) {
      throw new Error('Missing tenant context')
    }
    const state = this.states.get(tenantId)
    return state ? cloneState(state) : null
  }

  async saveState(state: AuditChainVerificationState): Promise<AuditChainVerificationState> {
    const tenantId = getTenantId()
    if (!tenantId) {
      throw new Error('Missing tenant context')
    }
    validateState(state)
    const cloned = cloneState(state)
    this.states.set(tenantId, cloned)
    return cloneState(cloned)
  }

  async clear(): Promise<void> {
    const tenantId = getTenantId()
    if (!tenantId) {
      throw new Error('Missing tenant context')
    }
    this.states.delete(tenantId)
  }
}
