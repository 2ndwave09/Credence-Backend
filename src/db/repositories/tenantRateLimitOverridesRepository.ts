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

export class TenantRateLimitValidationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'TenantRateLimitValidationError'
  }
}

export const MAX_RATE_LIMIT = Number.MAX_SAFE_INTEGER
export const MAX_WINDOW_SIZE = Number.MAX_SAFE_INTEGER

function validateTenantId(tenantId: unknown): string {
  if (typeof tenantId !== 'string') {
    throw new TenantRateLimitValidationError('tenantId must be a string')
  }
  const trimmed = tenantId.trim()
  if (trimmed.length === 0) {
    throw new TenantRateLimitValidationError('tenantId must be a non-empty string')
  }
  if (trimmed.length > 255) {
    throw new TenantRateLimitValidationError('tenantId must be at most 255 characters')
  }
  return trimmed
}

function validatePositiveInteger(value: unknown, field: string, max: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new TenantRateLimitValidationError(`${field} must be a finite number`)
  }
  if (!Number.isInteger(value)) {
    throw new TenantRateLimitValidationError(`${field} must be an integer`)
  }
  if (value <= 0) {
    throw new TenantRateLimitValidationError(`${field} must be greater than 0`)
  }
  if (value > max) {
    throw new TenantRateLimitValidationError(`${field} must be at most ${max}`)
  }
  return value
}

function validateReason(reason: unknown): string | undefined {
  if (reason === undefined || reason === null) {
    return undefined
  }
  if (typeof reason !== 'string') {
    throw new TenantRateLimitValidationError('reason must be a string')
  }
  if (reason.length > 2000) {
    throw new TenantRateLimitValidationError('reason must be at most 2000 characters')
  }
  return reason.length === 0 ? undefined : reason
}

type Row = {
  id: number
  tenant_id: string
  rate_limit: number | string
  window_size: number | string
  reason: string | null
  created_at: Date | string
  updated_at: Date | string
}

function toIsoString(value: Date | string, field: string): string {
  const date = value instanceof Date ? value : new Date(value)
  if (Number.isNaN(date.getTime())) {
    throw new TenantRateLimitValidationError(`${field} is not a valid timestamp`)
  }
  return date.toISOString()
}

const mapRow = (row: Row): TenantRateLimitOverride => ({
  id: row.id,
  tenantId: row.tenant_id,
  rateLimit: Number(row.rate_limit),
  windowSize: Number(row.window_size),
  reason: row.reason ?? undefined,
  createdAt: toIsoString(row.created_at, 'created_at'),
  updatedAt: toIsoString(row.updated_at, 'updated_at'),
})

export class PostgresTenantRateLimitOverridesRepository implements TenantRateLimitOverridesRepository {
  constructor(private readonly db: Queryable) {}

  async findByTenantId(tenantId: string): Promise<TenantRateLimitOverride | null> {
    const normalized = validateTenantId(tenantId)
    const result = await this.db.query<Row>(
      `SELECT id, tenant_id, rate_limit, window_size, reason, created_at, updated_at
       FROM tenant_rate_limit_overrides
       WHERE tenant_id = $1 LIMIT 1`,
      [normalized]
    )
    return result.rows[0] ? mapRow(result.rows[0]) : null
  }

  async upsert(tenantId: string, rateLimit: number, windowSize: number, reason?: string): Promise<TenantRateLimitOverride> {
    const normalizedTenantId = validateTenantId(tenantId)
    const normalizedRateLimit = validatePositiveInteger(rateLimit, 'rateLimit', MAX_RATE_LIMIT)
    const normalizedWindowSize = validatePositiveInteger(windowSize, 'windowSize', MAX_WINDOW_SIZE)
    const normalizedReason = validateReason(reason)

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
      [normalizedTenantId, normalizedRateLimit, normalizedWindowSize, normalizedReason ?? null]
    )
    const row = result.rows[0]
    if (!row) {
      throw new Error('upsert failed to return a row for tenant rate limit override')
    }
    return mapRow(row)
  }

  async delete(tenantId: string): Promise<boolean> {
    const normalized = validateTenantId(tenantId)
    const result = await this.db.query(
      `DELETE FROM tenant_rate_limit_overrides WHERE tenant_id = $1`,
      [normalized]
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
  private overrides = new Map<string, TenantRateLimitOverride>()\n  private idCounter = 1

  async findByTenantId(tenantId: string): Promise<TenantRateLimitOverride | null> {
    const normalized = validateTenantId(tenantId)
    const item = this.overrides.get(normalized)
    return item ? { ...item } : null
  }

  async upsert(tenantId: string, rateLimit: number, windowSize: number, reason?: string): Promise<TenantRateLimitOverride> {
    const normalizedTenantId = validateTenantId(tenantId)
    const normalizedRateLimit = validatePositiveInteger(rateLimit, 'rateLimit', MAX_RATE_LIMIT)
    const normalizedWindowSize = validatePositiveInteger(windowSize, 'windowSize', MAX_WINDOW_SIZE)
    const normalizedReason = validateReason(reason)

    const now = new Date().toISOString()
    const existing = this.overrides.get(normalizedTenantId)
    const item: TenantRateLimitOverride = {
      id: existing?.id ?? this.idCounter++,
      tenantId: normalizedTenantId,
      rateLimit: normalizedRateLimit,
      windowSize: normalizedWindowSize,
      reason: normalizedReason,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    }
    this.overrides.set(normalizedTenantId, item)
    return { ...item }
  }

  async delete(tenantId: string): Promise<boolean> {
    const normalized = validateTenantId(tenantId)
    return this.overrides.delete(normalized)
  }

  async listAll(): Promise<TenantRateLimitOverride[]> {
    return Array.from(this.overrides.values())
      .map((item) => ({ ...item }))
      .sort((a, b) => (a.tenantId < b.tenantId ? -1 : a.tenantId > b.tenantId ? 1 : 0))
  }

  async clear(): Promise<void> {
    this.overrides.clear()
    this.idCounter = 1
  }
}
