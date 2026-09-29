import { logger as rootLogger } from '../utils/logger.js'
import {
  AnalyticsRefreshStrategy,
  type Connectable,
  DEFAULT_ANALYTICS_VIEW_SPECS,
  type AnalyticsViewSpec,
  type RefreshStrategyResult,
  type AnalyticsRefreshMetrics,
} from '../services/analytics/refreshStrategy.js'

/**
 * Result of a single worker invocation. Carries enough structure for the
 * scheduler to maintain its consecutive-failure counter and for operators
 * to debug a failed tick from logs alone.
 */
export interface AnalyticsRefreshWorkerResult {
  startTime: string
  durationMs: number
  refreshed: boolean
  refreshedViews: string[]
  failedViews: RefreshStrategyResult['failedViews']
  cacheGeneration?: number
  /** Top-level non-fatal error message (e.g. unexpected runtime crash). */
  error?: string
}

export interface AnalyticsRefreshWorkerOptions {
  strategy: AnalyticsRefreshStrategy
  metrics?: AnalyticsRefreshMetrics
  logger?: ((msg: string) => void)
  yearning?: (consumer: () => Promise<void>) => Promise<void>
}

/**
 * Thin orchestration layer over the strategy. The worker is intentionally
 * stateful in its *result* (it tracks the last invocation for status
 * queries) but the consecutive-failure counter lives in the scheduler
 * (see `src/jobs/analyticsRefreshScheduler.ts`) so each replica owns its
 * own cooldown decision.
 *
 * Invariants:
 *  - A worker instance never runs two invocations concurrently; a concurrent
 *    `run()` returns the in-flight result rather than double-refreshing.
 *  - `run()` never throws; all failures are reported in the result and logs.
 *  - `failedViews` and `refreshedViews` are always defensively copied and
 *    normalized so callers cannot mutate internal state and duplicate entries
 *    cannot inflate counters.
 */
export class AnalyticsRefreshWorker {
  private readonly strategy: AnalyticsRefreshStrategy
  private readonly metrics?: AnalyticsRefreshMetrics
  private readonly log: (msg: string) => void
  private lastResult: AnalyticsRefreshWorkerResult | null = null
  /** In-flight invocation, if any. Guards overlapping runs. */
  private inFlight: Promise<AnalyticsRefreshWorkerResult> | null = null

  constructor(options: AnalyticsRefreshWorkerOptions) {
    if (!options || !options.strategy) {
      throw new Error('AnalyticsRefreshWorker requires a strategy')
    }
    this.strategy = options.strategy
    this.metrics = options.metrics
    this.log = options.logger ?? ((msg: string) => rootLogger.info(msg))
  }

  /**
   * Run a single refresh tick. Concurrent calls coalesce onto the in-flight
   * invocation so the underlying strategy is never entered twice concurrently.
   */
  async run(): Promise<AnalyticsRefreshWorkerResult> {
    if (this.inFlight) {
      this.log('[analytics] worker.run already in flight — coalescing')
      return this.inFlight
    }
    const runPromise = this.runInternal()
    this.inFlight = runPromise
    try {
      return await runPromise
    } finally {
      this.inFlight = null
    }
  }

  private async runInternal(): Promise<AnalyticsRefreshWorkerResult> {
    const startMs = Date.now()
    const startTime = new Date(startMs).toISOString()

    this.log('[analytics] worker.run start')

    try {
      const result = await this.strategy.refreshAll()
      const normalized = normalizeStrategyResult(result)
      const refreshed = normalized.failedViews.length === 0
      const workerResult: AnalyticsRefreshWorkerResult = {
        startTime,
        durationMs: normalized.totalDurationMs,
        refreshed,
        refreshedViews: normalized.refreshedViews,
        failedViews: normalized.failedViews,
        cacheGeneration: normalized.cacheGeneration,
      }
      this.lastResult = workerResult
      this.log(
        refreshed
          ? `[analytics] worker.run ok — refreshed=${normalized.refreshedViews.length} durationMs=${normalized.totalDurationMs} cacheGen=${normalized.cacheGeneration}`
          : `[analytics] worker.run degraded — refreshed=${normalized.refreshedViews.length} failed=${normalized.failedViews
              .map((v) => v.view)
              .join(',')} durationMs=${normalized.totalDurationMs}`,
      )
      return workerResult
    } catch (error) {
      const durationMs = Date.now() - startMs
      const message = error instanceof Error ? error.message : String(error)
      const workerResult: AnalyticsRefreshWorkerResult = {
        startTime,
        durationMs,
        refreshed: false,
        refreshedViews: [],
        failedViews: [],
        error: message,
      }
      this.lastResult = workerResult
      this.log(`[analytics] worker.run crashed after ${durationMs}ms: ${message}`)
      return workerResult
    }
  }

  /** Last invocation result, useful for health/status exports. */
  getLastResult(): AnalyticsRefreshWorkerResult | null {
    return this.lastResult
  }

  /** True while a refresh tick is in flight. */
  isRunning(): boolean {
    return this.inFlight !== null
  }
}

/**
 * Defensively normalize a strategy result so downstream consumers (and the
 * scheduler's failure counter) see only well-formed, deduplicated data.
 * Missing or malformed fields from a strategy are coerced to safe defaults
 * rather than throwing, so a partially-broken strategy cannot crash the worker.
 */
function normalizeStrategyResult(
  result: RefreshStrategyResult | null | undefined,
): RefreshStrategyResult {
  const safe = result ?? ({} as RefreshStrategyResult)
  const refreshedViews = dedupeStrings(safe.refreshedViews)
  const failedViews = dedupeFailedViews(safe.failedViews)
  const totalDurationMs =
    typeof safe.totalDurationMs === 'number' && Number.finite(safe.totalDurationMs) && safe.totalDurationMs >= 0
      ? safe.totalDurationMs
      : 0
  const cacheGeneration =
    typeof safe.cacheGeneration === 'number' && Number.finite(safe.cacheGeneration)
      ? safe.cacheGeneration
      : undefined
  return {
    refreshedViews,
    failedViews,
    totalDurationMs,
    cacheGeneration: cacheGeneration as number,
  } as RefreshStrategyResult
}

function dedupeStrings(values: unknown): string[] {
  if (!Array.isArray(values)) return []
  const seen = new Set<string>()
  const out: string[] = []
  for (const v of values) {
    if (typeof v !== 'string' || v.length === 0) continue
    if (seen.has(v)) continue
    seen.add(v)
    out.push(v)
  }
  return out
}

function dedupeFailedViews(values: unknown): RefreshStrategyResult['failedViews'] {
  if (!Array.isArray(values)) return []
  const seen = new Set<string>()
  const out: RefreshStrategyResult['failedViews'] = []
  for (const entry of values) {
    if (!entry || typeof entry !== 'object') continue
    const view = (entry as { view?: unknown }).view
    if (typeof view !== 'string' || view.length === 0) continue
    if (seen.has(view)) continue
    seen.add(view)
    out.push(entry as RefreshStrategyResult['failedViews'][number])
  }
  return out
}

/**
 * Factory: builds a worker pointed at a real Postgres pool with default view
 * specs. Tests use the explicit constructor instead so they can inject a
 * stub strategy.
 */
export function createAnalyticsRefreshWorker(options: {
  pool: Connectable
  views?: AnalyticsViewSpec[]
  maxAttemptsPerView?: number
  retryBackoffMs?: number
  metrics?: AnalyticsRefreshMetrics
  logger?: (msg: string) => void
}): AnalyticsRefreshWorker {
  const strategy = new AnalyticsRefreshStrategy({
    pool: options.pool,
    views: options.views ?? [...DEFAULT_ANALYTICS_VIEW_SPECS],
    maxAttemptsPerView: options.maxAttemptsPerView,
    retryBackoffMs: options.retryBackoffMs,
    metrics: options.metrics,
    logger: options.logger,
  })
  return new AnalyticsRefreshWorker({ strategy, metrics: options.metrics, logger: options.logger })
}
