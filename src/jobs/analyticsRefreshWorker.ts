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
  /**
   * Optional clock injection for deterministic testing of duration/startTime.
   * Defaults to `Date.now.bind(Date)`.
   */
  now?: () => number
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
 *    `run()` returns the in-flight promise so callers cannot double-refresh or
 *    observe interleaved state.
 *  - `run()` never rejects; errors are surfaced as `error` on the result so
 *    the scheduler can count failures without a try/catch at the call site.
 *  - `totalDurationMs` from the strategy is normalized to a non-negative,
 *    finite number and falls back to the wall-clock duration when the strategy
 *    reports a non-finite value.
 */
export class AnalyticsRefreshWorker {
  private readonly strategy: AnalyticsRefreshStrategy
  private readonly metrics?: AnalyticsRefreshMetrics
  private readonly log: (msg: string) => void
  private readonly now: () => number
  private lastResult: AnalyticsRefreshWorkerResult | null = null
  /** In-flight invocation, if any. Enforces single-flight semantics. */
  private inFlight: Promise<AnalyticsRefreshWorkerResult> | null = null

  constructor(options: AnalyticsRefreshWorkerOptions) {
    if (!options || !options.strategy) {
      throw new Error('AnalyticsRefreshWorker requires a strategy')
    }
    if (typeof options.strategy.refreshAll !== 'function') {
      throw new Error('AnalyticsRefreshWorker strategy must expose refreshAll()')
    }
    this.strategy = options.strategy
    this.metrics = options.metrics
    this.log = options.logger ?? ((msg: string) => rootLogger.info(msg))
    this.now = options.now ?? (() => Date.now())
  }

  /**
   * Run a single refresh tick. Concurrent calls coalesce onto the same
   * in-flight promise so a slow tick cannot be double-scheduled by
   * overlapping timers or replicas sharing a worker instance.
   */
  async run(): Promise<AnalyticsRefreshWorkerResult> {
    if (this.inFlight) {
      this.log('[analytics] worker.run coalesced onto in-flight tick')
      return this.inFlight
    }
    const promise = this.execute()
    this.inFlight = promise
    try {
      return await promise
    } finally {
      // Only clear if we are still the active in-flight tick.
      if (this.inFlight === promise) {
        this.inFlight = null
      }
    }
  }

  private async execute(): Promise<AnalyticsRefreshWorkerResult> {
    const startMs = this.now()
    const startTime = new Date(startMs).toISOString()

    this.log('[analytics] worker.run start')

    try {
      const result = await this.strategy.refreshAll()
      const failedViews = Array.isArray(result?.failedViews) ? result.failedViews : []
      const refreshedViews = Array.isArray(result?.refreshedViews) ? result.refreshedViews : []
      const refreshed = failedViews.length === 0
      const workerResult: AnalyticsRefreshWorkerResult = {
        startTime,
        durationMs: normalizeDuration(result?.totalDurationMs, this.now() - startMs),
        refreshed,
        refreshedViews,
        failedViews,
        cacheGeneration: result?.cacheGeneration,
      }
      this.lastResult = workerResult
      this.log(
        refreshed
          ? `[analytics] worker.run ok — refreshed=${refreshedViews.length} durationMs=${workerResult.durationMs} cacheGen=${workerResult.cacheGeneration}`
          : `[analytics] worker.run degraded — refreshed=${refreshedViews.length} failed=${failedViews
              .map((v) => v?.view)
              .join(',')} durationMs=${workerResult.durationMs}`,
      )
      return workerResult
    } catch (error) {
      const durationMs = normalizeDuration(undefined, this.now() - startMs)
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

  /** True while a tick is executing; useful for liveness/readiness probes. */
  isRunning(): boolean {
    return this.inFlight !== null
  }
}

/**
 * Normalize a duration value to a non-negative, finite number. Non-finite
 * or negative values fall back to the wall-clock duration so metrics and
 * logs never report a garbage duration.
 */
function normalizeDuration(value: unknown, fallback: number): number {
  if (typeof value === 'number' && Number.finite(value) && value >= 0) {
    return value
  }
  if (Number.finite(fallback) && fallback >= 0) {
    return fallback
  }
  return 0
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
  if (!options || !options.pool) {
    throw new Error('createAnalyticsRefreshWorker requires a pool')
  }
  const views = options.views ?? [...DEFAULT_ANALYTICS_VIEW_SPECS]
  if (!Array.isArray(views) || views.length === 0) {
    throw new Error('createAnalyticsRefreshWorker requires at least one view spec')
  }
  const strategy = new AnalyticsRefreshStrategy({
    pool: options.pool,
    views,
    maxAttemptsPerView: options.maxAttemptsPerView,
    retryBackoffMs: options.retryBackoffMs,
    metrics: options.metrics,
    logger: options.logger,
  })
  return new AnalyticsRefreshWorker({ strategy, metrics: options.metrics, logger: options.logger })
}
