/**
 * Tests for the notification idempotency guard.
 *
 * These exercise the claim state machine against a fake `Queryable` that models Postgres' semantics for the claim statement exactly — including the
 * `ON CONFLICT ... DO UPDATE ... WHERE` guard, which pg-mem silently ignores
 * (it applies the update regardless of the WHERE), making pg-mem unusable here.
 * `notificationIdempotency.integration.test.ts` re-verifies the same behaviour
 * against a real Postgres when one is available.
 */
import { beforeEach, describe, expect, it, vi} from 'vitest'
import type { QueryResult, QueryResultRow } from 'pg'
import type { Queryable } from '../db/repositories/queryable.js'
import {
  DEFAULT_CLAIM_TIMEOUT_SECONDS,
  IdempotentNotificationJob,
  NotificationIdempotencyRepository,
  buildNotificationDeliveryJobKey,
  createIdempotentNotificationJob,
} from './notificationIdempotency.js'

interface Row {
  id: string
  job_key: string
  job_type: string
  status: 'pending' | 'completed' | 'failed'
  result: string | null
  attempted_at: Date
  completed_at: Date | null
  expires_at: Date
}

/**
 * In-memory stand-in for the `idempotent_job_attempts` table that reproduces
 * Postgres' evaluation of the statements in NotificationIdempotencyRepository.
 */
class FakeIdempotencyDb implements Queryable {
  readonly rows = new Map<string, Row>()
  readonly statements: string[] = []
  now = new Date('2026-07-29T12:00:00.000Z')

  advanceSeconds(seconds: number): void {
    this.now = new Date(this.now.getTime() + seconds * 1000)
  }

  async query<R extends QueryResultRow = QueryResultRow>(
    text: string,
    params: readonly unknown[] = []
  ): Promise<QueryResult<R>> {
    this.statements.push(text)
    const sql = text.trim()

    if (sql.startsWith('INSERT INTO idempotent_job_attempts')) {
      return this.claim(params) as QueryResult<R>
    }
    if (sql.startsWith('SELECT')) {
      return this.find(params) as QueryResult<R>
    }
    if (sql.startsWith('UPDATE idempotent_job_attempts')) {
      return this.markTerminal(sql, params) as QueryResult<R>
    }

    throw new Error(`Unexpected statement: ${sql}`)
  }

  private result(rows: Row[]): QueryResult<Row> {
    return { rows, rowCount: rows.length, command: '', oid: 0, fields: [] }
  }

  /** Mirrors: INSERT ... ON CONFLICT (job_key) DO UPDATE ... WHERE ... RETURNING */
  private claim(params: readonly unknown[]): QueryResult<Row> {
    const [id, jobKey, jobType, expiresInSeconds, claimTimeoutSeconds] = params as [
      string,
      string,
      string,
      number,
      number,
    ]

    const nowMs = this.now.getTime()
    const claimed: Row = {
      id,
      job_key: jobKey,
      job_type: jobType,
      status: 'pending',
      result: null,
      attempted_at: new Date(nowMs),
      completed_at: null,
      expires_at: new Date(nowMs + expiresInSeconds * 1000),
    }

    const existing = this.rows.get(jobKey)
    if (!existing) {
      this.rows.set(jobKey, claimed)
      return this.result([{ ...claimed }])
    }

    const reclaimable =
      existing.status === 'failed' ||
      existing.expires_at.getTime() <= nowMs ||
      (existing.status === 'pending' &&
        existing.attempted_at.getTime() <= nowMs - claimTimeoutSeconds * 1000)

    if (!reclaimable) {
      // ON CONFLICT DO UPDATE WHERE ... did not match: zero rows returned.
      return this.result([])
    }

    this.rows.set(jobKey, claimed)
    return this.result([{ ...claimed }])
  }

  /** Mirrors: SELECT ... WHERE job_key = $1 AND expires_at > NOW() */
  private find(params: readonly unknown[]): QueryResult<Row> {
    const row = this.rows.get(params[0] as string)
    if (!row || row.expires_at.getTime() <= this.now.getTime()) {
      return this.result([])
    }
    return this.result([{ ...row }])
  }

  /** Mirrors: UPDATE ... WHERE id = $2 (no-op when the id no longer matches) */
  private markTerminal(sql: string, params: readonly unknown[]): QueryResult<Row> {
    const [value, attemptId] = params as [string, string]
    const row = [...this.rows.values()].find(candidate => candidate.id === attemptId)
    if (!row) {
      return this.result([])
    }

    row.status = sql.includes("status = 'completed'") ? 'completed' : 'failed'
    row.result = value
    row.completed_at = new Date(this.now.getTime())
    return this.result([row])
  }
}

const JOB_KEY = buildNotificationDeliveryJobKey('notif-1')
const JOB_TYPE = 'notification_delivery'

function makeJob(
  db: Queryable,
  send: () => Promise<string>,
  expiresInSeconds = 3600,
  claimTimeoutSeconds = 900
)
{
  return new IdempotentNotificationJob(
    db,
    JOB_KEY,
    JOB_TYPE,
    { run: send },
    expiresInSeconds,
    claimTimeoutSeconds
  )
}

describe('IdempotentNotificationJob', () => {
  let db: FakeIdempotencyDb

  beforeEach(() => {
    db = new FakeIdempotencyDb()
  })

  it('runs the job on first claim and records the result', async () => {
    const send = vi.fn().mockResolved('sent-1')

    const result = await makeJob(db, send).execute()

    expect(send).toHaveBeenCalledTimes(1)
    expect(result.alreadyProcessed).toBe(false)
    expect(result.result).toBe('sent-1')
    expect(db.rows.get(JOB_KEY)?.status).toBe('completed')
  })

  it('does not re-send when a completed attempt is replayed', async () => {
    const send = vi.fn().mockResolved('sent-1')

    await makeJob(db, send).execute()
    const replay = await makeJob(db, send).execute()

    // The core guarantee of #988: the provider is invoked exactly once.
    expect(send).toHaveBeenCalledTimes(1)
    expect(replay.alreadyProcessed).toBe(true)
    expect(replay.result).toBe('sent-1')
  })

  it('lets only one of two concurrent workers send', async () => {
    const send = vi.fn().mockImplementation(
      () => new Promise<string>(resolve => setTimeout(() => resolve('sent-1'), 10))
    )

    const outcomes = await Promise.allSettled([
      makeJob(db, send).execute(),
      makeJob(db, send).execute(),
    ])

    expect(send).toHaveBeenCalledTimes(1)
    expect(outcomes.filter(outcome => outcome.status === 'fulfilled')).toHaveLength(1)

    const rejected = outcomes.find(outcome => outcome.status === 'rejected')
    expect((rejected as PromiseRejectedResult).reason.message).toContain('already pending')
  })

  it('refuses to send while another worker holds a fresh claim', async () => {
    await db.query(
      'INSERT INTO idempotent_job_attempts',
      ['held', JOB_KEY, JOB_TYPE, 3600, 900]
    )

    const send = vi.fn().mockResolved('sent-1')
    await expect(makeJob(db, send).execute()).rejects.toThrow('already pending')
    expect(send).not.toHaveBeenCalled()
  })

  it('reclaims a stale pending claim left by a crashed worker', async () => {
    await db.query(
      'INSERT INTO idempotent_job_attempts',
      ['crashed', JOB_KEY, JOB_TYPE, 86_400, 900]
    )

    // Crashed mid-send: the claim is never released. Before this fix the row
    // stayed 'pending' for the full 24h TTL and every retry was rejected.
    db.advanceSeconds(901)

    const send = vi.fn().mockResolved('sent-late')
    const result = await makeJob(db, send, 86_400, 900).execute()

    expect(send).toHaveBeenCalledTimes(1)
    expect(result.result).toBe('sent-late')
  })

  it('does not reclaim a pending claim that is still within its lease', async () => {
    await db.query(
      'INSERT INTO idempotent_job_attempts',
      ['inflight', JOB_KEY, JOB_TYPE, 86_400, 900]
    )
    db.advanceSeconds(899)

    const send = vi.fn().mockResolved('sent')
    await expect(makeJob(db, send, 86_400, 900).execute()).rejects.toThrow('already pending')
    expect(send).not.toHaveBeenCalled()
  })

  it('releases the claim on failure so the next retry can send', async () => {
    const failing = vi.fn().mockRejected(new Error('provider 503'))
    await expect(makeJob(db, failing).execute()).rejects.toThrow('provider 503')
    expect(db.rows.get(JOB_KEY)?.status).toBe('failed')

    const send = vi.fn().mockResolved('sent-retry')
    const result = await makeJob(db, send).execute()

    expect(send).toHaveBeenCalledTimes(1)
    expect(result.result).toBe('sent-retry')
  })

  it('re-sends once the recorded attempt has expired', async () => {
    const send = vi.fn().mockResolved('sent-1')
    await makeJob(db, send, 60).execute()

    db.advanceSeconds(61)
    await makeJob(db, send, 60).execute()

    expect(send).toHaveBeenCalledTimes(2)
  })

  it('ignores a zombie worker completing an attempt it no longer owns', async () => {
    await db.query(
      'INSERT INTO idempotent_job_attempts',
      ['zombie', JOB_KEY, JOB_TYPE, 86_400, 900]
    )
    db.advanceSeconds(901)

    const send = vi.fn().mockResolved('sent-by-owner')
    await makeJob(db, send, 86_400, 900).execute()

    // The crashed worker finally reports success against its rotated-away id.
    const repo = new NotificationIdempotencyRepository(db)
    await repo.markCompleted('zombie', JSON.stringify('sent-by-zombie'))

    expect(db.rows.get(JOB_KEY)?.result).toBe(JSON.stringify('sent-by-owner'))
  })

  it('surfaces a null result for a completed attempt with no recorded payload', async () => {
    const send = vi.fn().mockResolved(undefined)
    await makeJob(db, send).execute()

    const replay = await makeJob(db, send).execute()
    expect(replay.alreadyProcessed).toBe(true)
    expect(replay.result).toBeNull()
  })

  it('reports a non-Error throw as Unknown error', async () => {
    const failing = vi.fn().mockRejected('string failure')
    await expect(makeJob(db, failing).execute()).rejects.toBe('string failure')
    expect(db.rows.get(JOB_KEY)?.result).toBe('Unknown error')
  })

  it('applies default TTL and claim lease via the factory', async () => {
    const send = vi.fn().mockResolved('sent')
    await createIdempotentNotificationJob(db, JOB_KEY, JOB_TYPE, { run: send }).execute()

    const row = db.rows.get(JOB_KEY)
    const ttlSeconds = (row!.expires_at.getTime() - row!.attempted_at.getTime()) / 1000
    expect(ttlSeconds).toBe(24 * 60 * 60)
    expect(DEFAULT_CLAIM_TIMEOUT_SECONDS).toBe(15 * 60)
  })
})

describe('lost claim with no readable row', () => {
  it('reports a duplicate rather than sending', async () => {
    // Claim lost, then the row is swept before it can be read back. Sending here
    // would risk a duplicate, so the job must refuse.
    const emptyDb: Queryable = {
      query: async () =>
        ({ rows: [], rowCount: 0, command: '', oid: 0, fields: [] }) as never,
    }

    const send = vi.fn().mockResolved('sent')
    const job = new IdempotentNotificationJob(emptyDb, JOB_KEY, JOB_TYPE, { run: send })

    await expect(job.execute()).rejects.toThrow('already pending')
    expect(send).not.toHaveBeenCalled()
  })
})

describe('claim statement contract', () => {
  it('infers the conflict target from job_key alone', async () => {
    const db = new FakeIdempotencyDb
    const repo = new NotificationIdempotencyRepository(db)

    await repo.claimAttempt({
      jobKey: JOB_KEY,
      jobType: JOB_TYPE,
      expiresInSeconds: 3600,
      claimTimeoutSeconds: 900,
    })

    const claimSql = db.statements[0]
    // A composite conflict target cannot be inferred against UNIQUE (job_key)
    // and raises Postgres 42P10 on every execution.
    expect(claimSql).toContain('ON CONFLICT (job_key) DO UPDATE')
    expect(claimSql).not.toMatch(/ON CONFLICT \([^)]*,/)
    // The guard is what prevents a concurrent claim from being overwritten.
    expect(claimSql).toContain("WHERE idempotent_job_attempts.status = 'failed'")
    expect(claimSql).toContain('RETURNING')
  })
})

describe('boundary and recovery coverage', () => {
  let db: FakeIdempotencyDb

  beforeEach(() => {
    db = new FakeIdempotencyDb()
  })

  it('reclaims at the exact claim-timeout boundary', async () => {
    await db.query(
      'INSERT INTO idempotent_job_attempts',
      ['boundary', JOB_KEY, JOB_TYPE, 86_400, 900]
    )
    // Exactly at the lease expiry: attempted_at <= now - timeout holds.
    db.advanceSeconds(900)

    const send = vi.fn().mockResolved('sent')
    const result = await makeJob(db, send, 86_400, 900).execute()

    expect(send).toHaveBeenCalledTimes(1)
    expect(result.result).toBe('sent')
  })

  it('does not reclaim one second before the claim-timeout boundary', async () => {
    await db.query(
      'INSERT INTO idempotent_job_attempts',
      ['not-yet', JOB_KEY, JOB_TYPE, 86_400, 900]
    )
    db.advanceSeconds(899)

    const send = vi.fn().mockResolved('sent')
    await expect(makeJob(db, send, 86_400, 900).execute()).rejects.toThrow('already pending')
    expect(send).not.toHaveBeenCalled()
  })

  it('reclaims at the exact TTL expiry boundary', async () => {
    const send = vi.fn().mockResolved('sent-1')
    await makeJob(db, send, 60).execute()

    // expires_at <= NOW() is reclaimable at the exact boundary.
    db.advanceSeconds(60)
    await makeJob(db, send, 60).execute()

    expect(send).toHaveBeenCalledTimes(2)
  })

  it('does not reclaim one second before TTL expiry', async () => {
    const send = vi.fn().mockResolved('sent-1')
    await makeJob(db, send, 60).execute()

    db.advanceSeconds(59)
    const replay = await makeJob(db, send, 60).execute()

    expect(send).toHaveBeenCalledTimes(1)
    expect(replay.alreadyProcessed).toBe(true)
  })

  it('treats an expired row as absent in findAttempt', async () => {
    const repo = new NotificationIdempotencyRepository(db)
    await repo.claimAttempt({
      jobKey: JOB_KEY,
      jobType: JOB_TYPE,
      expiresInSeconds: 60,
      claimTimeoutSeconds: 900,
    })

    db.advanceSeconds(61)
    expect(await repo.findAttempt(JOB_KEY)).toBeNull()
  })

  it('recovers from a failed attempt without waiting for the lease', async () => {
    // Failed rows are reclaimable immediately, even with a long claim lease.
    const failing = vi.fn().mockRejected(new Error('boom'))
    await expect(makeJob(db, failing, 86_400, 86_400).execute()).rejects.toThrow('boom')

    const send = vi.fn().mockResolved('ok')
    const result = await makeJob(db, send, 86_400, 86_400).execute()

    expect(send).toHaveBeenCalledTimes(1)
    expect(result.result).toBe('ok')
  })

  it('preserves the winner's result when a losing worker tries to mark failed', async () => {
    await db.query(
      'INSERT INTO idempotent_job_attempts',
      ['old-owner', JOB_KEY, JOB_TYPE, 86_400, 900]
    )
    db.advanceSeconds(901)

    const send = vi.fn().mockResolved('winner')
    await makeJob(db, send, 86_400, 900).execute()

    // The zombie worker reports failure against its rotated-away id.
    const repo = new NotificationIdempotencyRepository(db)
    await repo.markFailed('old-owner', 'zombie failure')

    expect(db.rows.get(JOB_KEY)?.status).toBe('completed')
    expect(db.rows.get(JOB_KEY)?.result).toBe(JSON.stringify('winner'))
  })

  it('preserves the winner's result when a losing worker tries to mark completed', async () => {
    await db.query(
      'INSERT INTO idempotent_job_attempts',
      ['old-owner', JOB_KEY, JOB_TYPE, 86_400, 900]
    )
    db.advanceSeconds(901)

    const send = vi.fn().mockResolved('winner')
    await makeJob(db, send, 86_400, 900).execute()

    const repo = new NotificationIdempotencyRepository(db)
    await repo.markCompleted('old-owner', JSON.stringify('zombie'))

    expect(db.rows.get(JOB_KEY)?.result).toBe(JSON.stringify('winner'))
  })

  it('returns null from claimAttempt when a completed row is within TTL', async () => {
    const repo = new NotificationIdempotencyRepository(db)
    const claimed = await repo.claimAttempt({
      jobKey: JOB_KEY,
      jobType: JOB_TYPE,
      expiresInSeconds: 3600,
      claimTimeoutSeconds: 900,
    })
    expect(claimed).not.toBeNull()
    await repo.markCompleted(claimed!.id, JSON.stringify('done'))

    expect(await repo.claimAttempt({
      jobKey: JOB_KEY,
      jobType: JOB_TYPE,
      expiresInSeconds: 3600,
      claimTimeoutSeconds: 900,
    })).toBeNull()
  })

  it('returns the recorded result on replay without re-sending', async () => {
    const send = vi.fn().mockResolved('sent')
    await makeJob(db, send).execute()

    const replay = await makeJob(db, send).execute()
    expect(replay.attempt?.status).toBe('completed')
    expect(replay.result).toBe('sent')
    expect(send).toHaveBeenCalledTimes(1)
  })

  it('surfaces the original error and records it on failure', async () => {
    const error = new Error('provider timeout')
    const failing = vi.fn().mockRejected(error)
    await expect(makeJob(db, failing, 86_400, 86_400).execute()).rejects.toBe(error)
    expect(db.rows.get(JOB_KEY)?.result).toBe('provider timeout')
  })

  it('rejects a concurrent claim while the winner is still running', async () => {
    let release: () => void = undefined
    const hold = new Promise<void>(resolve => {
      release = resolve
    })
    const send = vi.fn().mockImplementation(async () => {
      await hold
      return 'sent'
    })

    const winner = makeJob(db, send, 86_400, 86_400).execute()
    // Give the winner a turn to claim and enter the job.
    await new Promise(resolve => setTimeout(resolve, 0))

    await expect(makeJob(db, send, 86_400, 86_400).execute()).rejects.toThrow('already pending')

    release()
    const result = await winner
    expect(result.result).toBe('sent')
    expect(send).toHaveBeenCalledTimes(1)
  })

  it('recovers after a failed attempt when the claim lease has not lapsed', async () => {
    const failing = vi.fn().mockRejected(new Error('network'))
    await expect(makeJob(db, failing, 86_400, 86_400).execute()).rejects.toThrow('network')

    // No time advance: failed rows are immediately reclaimable.
    const send = vi.fn().mockResolved('recovered')
    const result = await makeJob(db, send, 86_400, 86_400).execute()
    expect(result.result).toBe('recovered')
  })

  it('keeps distinct job_keys independent', async () => {
    const otherKey = buildNotificationDeliveryJobKey('notif-2')
    const sendA = vi.fn().mockResolved('a')
    const sendB = vi.fn().mockResolved('b')

    await new IdempotentNotificationJob(db, JOB_KEY, JOB_TYPE, { run: sendA }, 3600, 900).execute()
    await new IdempotentNotificationJob(db, otherKey, JOB_TYPE, { run: sendB }, 3600, 900).execute()

    expect(sendA).toHaveBeenCalledTimes(1)
    expect(sendB).toHaveBeenCalledTimes(1)
    expect(db.rows.get(JOB_KEY)?.result).toBe(JSON.stringify('a'))
    expect(db.rows.get(otherKey)?.result).toBe(JSON.stringify('b'))
  })

  it('propagates a database error from claimAttempt without running the job', async () => {
    const failingDb: Queryable = {
      query: async () => {
        throw new Error('connection reset')
      },
    }

    const send = vi.fn().mockResolved('sent')
    const job = new IdempotentNotificationJob(failingDb, JOB_KEY, JOB_TYPE, { run: send })

    await expect(job.execute()).rejects.toThrow('connection reset')
    expect(send).not.toHaveBeenCalled()
  })
})
