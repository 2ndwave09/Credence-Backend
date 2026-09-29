/**
 * Domain event stored in the outbox table.
 */
export interface OutboxEvent {
  id: bigint
  aggregateType: string
  aggregateId: string
  eventType: string
  payload: Record<string, unknown>
  rawPayload?: string
  payloadParseError?: string
  status: OutboxEventStatus
  retryCount: number
  maxRetries: number
  consumerId?: string | null
  leaseExpiresAt?: Date | null
  createdAt: Date
  processedAt: Date | null
  errorMessage: string | null
  traceId?: string | null
  spanId?: string | null
  tracestate?: string | null
  shardCount?: number | null
  shardId?: number | null
  /**
   * Application-level correlation id (distinct from the OTel trace/span
   * ids above) captured from the originating HTTP request's tracing
   * context at emit time. Restored into the tracing context when this
   * event is published so downstream logs and outbound webhook requests
   * can be tied back to the request that caused them.
   */
  correlationId?: string | null
  /**
   * Set before publishing to prevent duplicate emissions if the worker
   * crashes mid-batch.  When present the publisher treats the event as
   * already delivered and skips straight to markPublished.
   */
  publishIdempotencyKey?: string | null
}

export type OutboxEventStatus = 'pending' | 'processing' | 'published' | 'failed' | 'dead_letter'

/**
 * Terminal states from which no further processing transitions are allowed.
 * Used by recovery/backfill logic to decide whether an event still needs work.
 */
export const TERMINAL_OUTBOX_STATUSES: readonly OutboxEventStatus[] = ['published', 'dead_letter']

/**
 * States that indicate an event is (or may be) actively leased by a worker.
 * Recovery must not steal a lease that has not yet expired.
 */
export const IN_FLIGHT_OUTBOX_STATUSES: readonly OutboxEventStatus[] = ['processing']

/**
 * Returns true when the status is terminal and the event must never be
 * re-processed, re-published, or re-quarantined.
 */
export function isTerminalOutboxStatus(status: OutboxEventStatus): boolean {
  return TERMINAL_OUTBOX_STATUSES.includes(status)
}

/**
 * Returns true when the event is currently leased by a worker.
 */
export function isInFlightOutboxStatus(status: OutboxEventStatus): boolean {
  return IN_FLIGHT_OUTBOX_STATUSES.includes(status)
}

export type OutboxQuarantineReason =
  | 'malformed_json'
  | 'schema_invalid'
  | 'oversized_payload'
  | 'unknown_event_type'

/**
 * Default retry budget applied when a caller does not specify maxRetries.
 * Kept here so backfill/recovery code and producers agree on the boundary.
 */
export const DEFAULT_MAX_RETRIES = 5

/**
 * Upper bound on retry budgets. Values above this are clamped so a single
 * poisoned event cannot pin a worker indefinitely.
 */
export const MAX_ALLOWED_RETRIES = 100

/**
 * Clamps a caller-supplied retry budget into the supported range.
 *
 * Invariants:
 * - Non-finite, negative, or fractional values fall back to the default.
 * - Values above MAX_ALLOWED_RETRIES are clamped down.
 * - The result is always a non-negative integer.
 */
export function normalizeMaxRetries(value: number | null | undefined): number {
  if (value === null || value === undefined) return DEFAULT_MAX_RETRIES
  if (!Number.isFinite(value)) return DEFAULT_MAX_RETRIES
  const truncated = Math.trunc(value)
  if (truncated < 0) return DEFAULT_MAX_RETRIES
  return Math.min(truncated, MAX_ALLOWED_RETRIES)
}

/**
 * Returns true when an event has exhausted its retry budget and must be
 * moved to the dead-letter path instead of being retried again.
 */
export function isRetryExhausted(retryCount: number, maxRetries: number): boolean {
  return retryCount >= normalizeMaxRetries(maxRetries)
}

export interface OutboxQuarantineEntry {
  id: bigint
  originalEventId: bigint
  aggregateType: string
  aggregateId: string
  eventType: string
  payload: Record<string, unknown> | string | null
  reason: OutboxQuarantineReason
  errorMessage: string
  retryCount: number
  maxRetries: number
  quarantinedAt: Date
  reinjectedAt: Date | null
  reinjectedBy: string | null
}

/**
 * Input for creating a new outbox event.
 */
export interface CreateOutboxEvent {
  aggregateType: string
  aggregateId: string
  eventType: string
  payload: Record<string, unknown>
  maxRetries?: number
  traceId?: string | null
  spanId?: string | null
  tracestate?: string | null
  correlationId?: string | null
}

/**
 * Configuration for outbox cleanup policy.
 */
/**
 * Default cleanup policy. Exported so tests and callers can assert the
 * boundary values without duplicating magic numbers.
 */
export const DEFAULT_OUTBOX_CLEANUP_CONFIG: OutboxCleanupConfig = {
  publishedRetentionDays: 7,
  failedRetentionDays: 30,
}

/**
 * Normalizes a cleanup config, rejecting non-finite or negative retention
 * windows. Invalid values fall back to the documented defaults so a bad
 * config cannot cause unbounded retention or accidental mass deletion.
 */
export function normalizeCleanupConfig(
  config: Partial<OutboxCleanupConfig> | null | undefined,
): OutboxCleanupConfig {
  const published = config?.publishedRetentionDays
  const failed = config?.failedRetentionDays
  return {
    publishedRetentionDays:
      typeof published === 'number' && Number.isFinite(published) && published >= 0
        ? Math.trunc(published)
        : DEFAULT_OUTBOX_CLEANUP_CONFIG.publishedRetentionDays,
    failedRetentionDays:
      typeof failed === 'number' && Number.isFinite(failed) && failed >= 0
        ? Math.trunc(failed)
        : DEFAULT_OUTBOX_CLEANUP_CONFIG.failedRetentionDays,
  }
}

export interface OutboxCleanupConfig {
  /** Delete published events older than this many days. Default: 7 */
  publishedRetentionDays: number
  /** Delete failed events older than this many days. Default: 30 */
  failedRetentionDays: number
}
