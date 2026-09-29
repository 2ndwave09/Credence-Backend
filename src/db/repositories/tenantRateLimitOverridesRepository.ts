import type { Queryable } from './queryable.js'

export interface TenantRateLimitOverride {
  id?: number
  tenantId: string
  rateLimit: number
  windowSize: number
  reason?: string
  createdAt?: string
  updatedAt?: string
}

export interface TenantRateLimitOverridesRepository {
  findByTenantId(tenantId: string): Promise<TenantRateLimitOverride | null>
  upsert(tenantId: string, rateLimit: number, windowSize: number, reason?: string): Promise<TenantRateLimitOverride>
  delete(tenantId: string): Promise<boolean>
  listAll(): Promise<TenantRateLimitOverride[]>
  clear(): Promise<void>
}

type Row = {
  id: number
  tenant_id: string
  rate_limit: number
  window_size: number
  reason: string | null
  created_at: Date | string
  updated_at: Date | string
}

/**
 * Validation invariants:
 * - tenantId must be a non-empty string (after trimming).
 * - rateLimit must be a finite integer >= 1.
 * - windowSize must be a finite integer >= 1.
 * - reason, when provided, must be a string (not undefined/null) and length <= MAX_REASON_LENGTH.
 */
export const MAX_REASON_LENGTH = 500

export class TenantRateLimitValidationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'TenantRateLimitValidationError'
  }
}

export function assertValidTenantId(tenantId: unknown): asserts tenantId is string {
  if (typeof tenantId !== 'string' || tenantId.trim().length === 0) {
    throw new TenantRateLimitValidationError('tenantId must be a non-empty string')
  }
}

export function assertValidRateLimit(rateLimit: unknown): asserts rateLimit is number {
  if (typeof rateLimit !== 'number' || !Number.isInteger(rateLimit) || rateLimit < 1) {
    throw new TenantRateLimitValidationError('rateLimit must be an integer >= 1')
  }
}

export function assertValidWindowSize(windowSize: unknown): asserts windowSize is number {
  if (typeof windowSize !== 'number' || !Number.isInteger(windowSize) || windowSize < 1) {
    throw new TenantRateLimitValidationError('windowSize must be an integer >= 1')
  }
}

export function assertValidReason(reason: unknown): asserts reason is string | undefined {
  if (reason === undefined) return
  if (typeof reason !== 'string') {
    throw new TenantRateLimitValidationError('reason must be a string when provided')
  }
  if (reason.length > MAX_REASON_LENGTH) {
    throw new TenantRateLimitValidationError(`reason must be at most ${MAX_REASON_LENGTH} characters`)
  }
}

const mapRow = (row: Row): TenantRateLimitOverride => ({
  id: row.id,
  tenantId: row.tenant_id,
  rateLimit: Number(row.rate_limit),
  windowSize: Number(row.window_size),
  reason: row.reason ?? undefined,
  createdAt: new Date(row.created_at).toISOString(),
  updatedAt: new Date(row.updated_at).toISOString(),
})

export class PostgresTenantRateLimitOverridesRepository implements TenantRateLimitOverridesRepository {
  constructor(private readonly db: Queryable) {}

  async findByTenantId(tenantId: string): Promise<TenantRateLimitOverride | null> {
    assertValidTenantId(tenantId)
    const result = await this.db.query<Row>(
      `SELECT id, tenant_id, rate_limit, window_size, reason, created_at, updated_at
       FROM tenant_rate_limit_overrides
       WHERE tenant_id = $1 LIMIT 1`,
      [tenantId]
    )
    return result.rows[0] ? mapRow(result.rows[0]) : null
  }

  async upsert(tenantId: string, rateLimit: number, windowSize: number, reason?: string): Promise<TenantRateLimitOverride> {
    assertValidTenantId(tenantId)
    assertValidRateLimit(rateLimit)
    assertValidWindowSize(windowSize)
    assertValidReason(reason)
    const result = await this.db.query<Row>(
      `INSERT INTO tenant_rate_limit_overrides (tenant_id, rate_limit, window_size, reason, updated_at)
       VALUES ($1, $2, $3, $4, NOW())
       ON CONFLICT (tenant_id)
       DO UPDATE SET
         rate_limit = EXCLUDED.rate_limit,
         window_size = EXCLUDED.window_size,
         reason = EXCLUDED.reason,
         updated_at = NOW()
       RETURNING id, tenant_id, rate_limit, window_size, reason, created_at, updated_at`,
      [tenantId, rateLimit, windowSize, reason ?? null]
    )
    return mapRow(result.rows[0])
  }

  async delete(tenantId: string): Promise<boolean> {
    assertValidTenantId(tenantId)
    const result = await this.db.query(
      `DELETE FROM tenant_rate_limit_overrides WHERE tenant_id = $1`,
      [tenantId]
    )
    return (result.rowCount ?? 0) > 0
  }

  async listAll(): Promise<TenantRateLimitOverride[]> {
    const result = await this.db.query<Row>(
      `SELECT id, tenant_id, rate_limit, window_size, reason, created_at, updated_at
       FROM tenant_rate_limit_overrides ORDER BY tenant_id ASC`
    )
    return result.rows.map(mapRow)
  }

  async clear(): Promise<void> {
    await this.db.query(`DELETE FROM tenant_rate_limit_overrides`)
  }
}

export class InMemoryTenantRateLimitOverridesRepository implements TenantRateLimitOverridesRepository {
  private overrides = new Map<string, TenantRateLimitOverride>()
  private idCounter = 1

  async findByTenantId(tenantId: string): Promise<TenantRateLimitOverride | null> {
    assertValidTenantId(tenantId)
    const item = this.overrides.get(tenantId)
    return item ? { ...item } : null
  }

  async upsert(tenantId: string, rateLimit: number, windowSize: number, reason?: string): Promise<TenantRateLimitOverride> {
    assertValidTenantId(tenantId)
    assertValidRateLimit(rateLimit)
    assertValidWindowSize(windowSize)
    assertValidReason(reason)
    const now = new Date().toISOString()
    const existing = this.overrides.get(tenantId)
    const item: TenantRateLimitOverride = {
      id: existing?.id ?? this.idCounter++,
      tenantId,
      rateLimit,
      windowSize,
      reason,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    }
    this.overrides.set(tenantId, item)
    return { ...item }
  }

  async delete(tenantId: string): Promise<boolean> {
    assertValidTenantId(tenantId)
    return this.overrides.delete(tenantId)
  }

  async listAll(): Promise<TenantRateLimitOverride[]> {
    return Array.from(this.overrides.values()).map((item) => ({ ...item }))
  }

  async clear(): Promise<void> {
    this.overrides.clear()
    this.idCounter = 1
  }
}
