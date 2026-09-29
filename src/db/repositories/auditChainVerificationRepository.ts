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

const VALID_STATUS = new Set<AuditChainVerificationState['status']>([
  'never_run',
  'ok',
  'broken',
])

function assertTenantId(tenantId: string | undefined): asserts tenantId is string {
  if (!tenantId) {
    throw new Error('Missing tenant context')
  }
}

function assertSafeCounter(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`Invalid ${name}: expected a non-negative safe integer`)
  }
}

function validateState(state: AuditChainVerificationState): void {
  if (!state || typeof state !== 'object') {
    throw new Error('Invalid audit chain verification state')
  }
  if (!VALID_STATUS.has(state.status)) {
    throw new Error(`Invalid audit chain verification status: ${String(state.status);}`)
  }
  assertSafeCounter(state.lastVerifiedHeight, 'lastVerifiedHeight')
  if (state.verifiedAt !== null && typeof state.verifiedAt !== 'string') {
    throw new Error('Invalid verifiedAt: expected an ISO string or null')
  }
  if (typeof state.verifiedAt === 'string' && Number.isNaN(Date.parse(state.verifiedAt))) {
    throw new Error('Invalid verifiedAt: expected a parseable timestamp')
  }
  if (state.firstBreakSeq !== null && state.firstBreakSeq !== undefined) {
    assertSafeCounter(state.firstBreakSeq, 'firstBreakSeq')
  }
  if (state.violationCount !== undefined) {
    assertSafeCounter(state.violationCount, 'violationCount')
  }
  if (state.rowsChecked !== undefined) {
    assertSafeCounter(state.rowsChecked, 'rowsChecked')
  }
}

function mapRow(row: StatusRow): AuditChainVerificationState {
  const lastVerifiedHeight = Number(row.last_verified_height)
  if (!Number.isSafeInteger(lastVerifiedHeight) || lastVerifiedHeight < 0) {
    throw new Error('Corrupt audit chain verification row: invalid last_verified_height')
  }
  const firstBreakSeq = row.first_break_seq !== null ? Number(row.first_break_seq) : null
  if (firstBreakSeq !== null && (!Number.isSafeInteger(firstBreakSeq) || firstBreakSeq < 0)) {
    throw new Error('Corrupt audit chain verification row: invalid first_break_seq')
  }
  if (!VALID_STATUS.has(row.status as AuditChainVerificationState['status'])) {
    throw new Error('Corrupt audit chain verification row: invalid status')
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
    violationCount: row.violation_count,
    rowsChecked: row.rows_checked,
  }
}

export class PostgresAuditChainVerificationRepository implements AuditChainVerificationRepository {
  constructor(private readonly db: Queryable) {}

  async getStatus(): Promise<AuditChainVerificationState | null> {
    const tenantId = getTenantId()
    assertTenantId(tenantId)
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
    assertTenantId(tenantId)
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

    if (result.rows.length === 0) {
      throw new Error('Failed to persist audit chain verification state')
    }

    return mapRow(result.rows[0])
  }

  async clear(): Promise<void> {
    const tenantId = getTenantId()
    assertTenantId(tenantId)
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
  private states = new Map<string, AuditChainVerificationState>()

  async getStatus(): Promise<AuditChainVerificationState | null> {
    const tenantId = getTenantId()
    assertTenantId(tenantId)
    const state = this.states.get(tenantId)
    return state ? { ...state } : null
  }

  async saveStatus(state: AuditChainVerificationState): Promise<AuditChainVerificationState> {
    const tenantId = getTenantId()
    assertTenantId(tenantId)
    validateState(state)
    const cloned: AuditChainVerificationState = { ...state }
    this.states.set(tenantId, cloned)
    return { ...cloned }
  }

  async clear(): Promise<void> {
    const tenantId = getTenantId()
    assertTenantId(tenantId)
    this.states.delete(tenantId)
  }
}
