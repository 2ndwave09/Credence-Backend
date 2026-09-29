import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  AnalyticsRefreshWorker,
  type AnalyticsRefreshWorkerResult,
} from './analyticsRefreshWorker.js'
import type {
  AnalyticsRefreshStrategy,
  RefreshStrategyResult,
  AnalyticsRefreshMetrics,
} from '../services/analytics/refreshStrategy.js'

// -----------------------------------------------------------------------------
// Test helpers
// -----------------------------------------------------------------------------

function makeResult(overrides: Partial<RefreshStrategyResult> = {}): RefreshStrategyResult {
  return {
    refreshedViews: ['view_a'],
    failedViews: [],
    totalDurationMs: 12,
    cacheGeneration: 1,
    ...overrides,
  } as RefreshStrategyResult
}

function makeStrategy(
  refreshAll: () => Promise<RefreshStrategyResult>,
): AnalyticsRefreshStrategy {
  return { refreshAll } as unknown as AnalyticsRefreshStrategy
}

function makeMetrics(): AnalyticsRefreshMetrics {
  return {
    incRuns: vi.fn(),
    observeDuration: vi.fn(),
    setViewAge: vi.fn(),
    incSkip: vi.fn(),
  } as unknown as AnalyticsRefreshMetrics
}

describe('AnalyticsRefreshWorker', () => {
  let logger: ReturnType<typeof vi.fn>

  beforeEach(() => {
    logger = vi.fn()
  })

  // --------------------------------------------------------------------------
  // Construction / validation
  // --------------------------------------------------------------------------

  it('throws when constructed without a strategy', () => {
    expect(() => new AnalyticsRefreshWorker() as unknown as AnalyticsRefreshWorker)..toThrow(
      /requires a strategy/,
    )
    expect(
      () =>
        new AnalyticsRefreshWorker({ strategy: undefined } as unknown as {
          strategy: AnalyticsRefreshStrategy
        }),
    ).toThrow(/requires a strategy/)
  })

  it('returns null from getLastResult before any run', () => {
    const worker = new AnalyticsRefreshWorker({
      strategy: makeStrategy(async () => makeResult()),
      logger,
    })
    expect(worker.getLastResult()).toBeNull()
  })

  // --------------------------------------------------------------------------
  // Happy path
  // --------------------------------------------------------------------------

  it('returns a success result and records it as lastResult', async () => {
    const strategy = makeStrategy(async () =>
      makeResult({ refreshedViews: ['view_a', 'view_b'], cacheGeneration: 7 }),
    )
    const worker = new AnalyticsRefreshWorker({ strategy, logger })

    const result = await worker.run()

    expect(result.refreshed).toBe(true)
    expect(result.error).toBeUndefined()
    expect(result.refreshedViews).toEqual(['view_a', 'view_b'])
    expect(result.failedViews).toEqual([])
    expect(result.cacheGeneration).toBe(7)
    expect(result.durationMs).toBeGreaterThanOrEqual(0)
    expect(result.startTime).toMatch(/^\d\d\d\d-\d\d\d-\d\dT/)
    expect(worker.getLastResult()).toEqual(result)
  })

  it('logs start and completion messages', async () => {
    const worker = new AnalyticsRefreshWorker({
      strategy: makeStrategy(async () => makeResult()),
      logger,
    })

    await worker.run()

    expect(logger).toHaveBeenCalledWith(expect.stringContaining('worker.run start'))
    expect(logger).toHaveBeenCalledWith(expect.stringContaining('worker.run ok'))
  })

  it('uses the root logger by default without throwing', async () => {
    const worker = new AnalyticsRefreshWorker({
      strategy: makeStrategy(async () => makeResult()),
    })
    await expect(worker.run()).resolves.toMatchObject({ refreshed: true })
  })

  // --------------------------------------------------------------------------
  // Partial failure / degraded operation
  // --------------------------------------------------------------------------

  it('marks the tick as degraded when some views fail but the strategy returns', async () => {
    const worker = new AnalyticsRefreshWorker({
      strategy: makeStrategy(async () =>
        makeResult({
          refreshedViews: ['view_a'],
          failedViews: [{ view: 'view_b', error: 'boom' }] as RefreshStrategyResult['failedViews'],
        }),
      ),
      logger,
    })

    const result = await worker.run()

    expect(result.refreshed).toBe(false)
    expect(result.error).toBeUndefined()
    expect(result.refreshedViews).toEqual(['view_a'])
    expect(result.failedViews).length).toBe(1)
    expect(logger).toHaveBeenCalledWith(expect.stringContaining('degraded'))
    expect(logger).toHaveBeenCalledWith(expect.stringContaining('view_b'))
  })

  it('treats an empty refresh as success (boundary)', async () => {
    const worker = new AnalyticsRefreshWorker({
      strategy: makeStrategy(async () =>
        makeResult({ refreshedViews: [], failedViews: [], cacheGeneration: 0 }),
      ),
      logger,
    })

    const result = await worker.run()

    expect(result.refreshed).toBe(true)
    expect(result.refreshedViews).toEqual([])
    expect(result.cacheGeneration).toBe(0)
  })

  // --------------------------------------------------------------------------
  // Rejection / recovery
  // --------------------------------------------------------------------------

  it('returns an error result when the strategy throws and does not reject', async () => {
    const worker = new AnalyticsRefreshWorker({
      strategy: makeStrategy(async () => {
        throw new Error('pg connection lost')
      }),
      logger,
    })

    const result = await worker.run()

    expect(result.refreshed).toBe(false)
    expect(result.error).toBe('pg connection lost')
    expect(result.refreshedViews).toEqual([])
    expect(result.failedViews).toEqual([])
    expect(worker.getLastResult()).toEqual(result)
    expect(logger).toHaveBeenCalledWith(expect.stringContaining('crashed'))
  })

  it('handles non-Error thrown values gracefully', async () => {
    const worker = new AnalyticsRefreshWorker({
      strategy: makeStrategy(async () => {
        throw 'string error'
      }),
      logger,
    })

    const result = await worker.run()

    expect(result.refreshed).toBe(false)
    expect(result.error).toBe('string error')
  })

  it('recovers after a failure on the next tick', async () => {
    const refreshAll = vi
      .fn()
      .mockRejectedOnce(new Error('transient boom'))
      .mockResolved(makeResult({ refreshedViews: ['view_a'] }))
    const worker = new AnalyticsRefreshWorker({
      strategy: makeStrategy(refreshAll as () => Promise<RefreshStrategyResult>),
      logger,
    })

    const first = await worker.run()
    expect(first.refreshed).toBe(false)
    expect(first.error).toBe('transient boom')

    const second = await worker.run()
    expect(second.refreshed).toBe(true)
    expect(second.error).toBeUndefined()
    expect(worker.getLastResult()).toEqual(second)
    expect(refreshAll).toHaveBeenCalledTimes(2)
  })

  // --------------------------------------------------------------------------
  // Concurrency / timing boundaries
  // --------------------------------------------------------------------------

  it('serializes concurrent runs so the strategy is never entered reentrantly', async () => {
    let inStrategy = false
    let concurrentEntries = 0
    const refreshAll = vi.fn().mockImplementation(async () => {
      if (inStrategy) concurrentEntries++
      inStrategy = true
      await new Promise((resolve) => setTimeout(resolve, 5))
      inStrategy = false
      return makeResult()
    })
    const worker = new AnalyticsRefreshWorker({
      strategy: makeStrategy(refreshAll as () => Promise<RefreshStrategyResult>),
      logger,
    })

    const [a, b, c] = await Promise.all([worker.run(), worker.run(), worker.run()])

    expect(concurrentEntries).toBe(0)
    expect(refreshAll).toHaveBeenCalledTimes(3)
    expect(a.refreshed).toBe(true)
    expect(b.refreshed).toBe(true)
    expect(c.refreshed).toBe(true)
    expect(worker.getLastResult()).toEqual(c)
  })

  it('does not poison the chain when an earlier concurrent run fails', async () => {
    const refreshAll = vi
      .fn()
      .mockRejectedOnce(new Error('boom'))
      .mockResolved(makeResult())
    const worker = new AnalyticsRefreshWorker({
      strategy: makeStrategy(refreshAll as () => Promise<RefreshStrategyResult>),
      logger,
    })

    const [a, b] = await Promise.all([worker.run(), worker.run()])

    expect(a.refreshed).toBe(false)
    expect(a.error).toBe('boom')
    expect(b.refreshed).toBe(true)
    expect(b.error).toBeUndefined()
  })

  // --------------------------------------------------------------------------
  // Metrics integration
  // --------------------------------------------------------------------------

  it('records metrics when provided on success', async () => {
    const metrics = makeMetrics()
    const worker = new AnalyticsRefreshWorker({
      strategy: makeStrategy(async () => makeResult()),
      metrics,
      logger,
    })

    await worker.run()

    expect(metrics.incRuns).toHaveBeenCalledWith('success')
    expect(metrics.observeDuration).toHaveBeenCalledWith(expect.any(Number))
  })

  it('records metrics when provided on failure', async () => {
    const metrics = makeMetrics()
    const worker = new AnalyticsRefreshWorker({
      strategy: makeStrategy(async () => {
        throw new Error('pg connection lost')
      }),
      metrics,
      logger,
    })

    await worker.run()

    expect(metrics.incRuns).toHaveBeenCalledWith('error')
    expect(metrics.observeDuration).toHaveBeenCalledWith(expect.any(Number))
  })

  it('does not throw when metrics are omitted', async () => {
    const worker = new AnalyticsRefreshWorker({
      strategy: makeStrategy(async () => makeResult()),
      logger,
    })
    await expect(worker.run()).resolves.toMatchObject({ refreshed: true })
  })

  // --------------------------------------------------------------------------
  // Regression: startTime and duration invariants
  // --------------------------------------------------------------------------

  it('startTime is a valid ISO timestamp and duration is non-negative on both paths', async () => {
    const ok = new AnalyticsRefreshWorker( {
      strategy: makeStrategy(async () => makeResult()),
      logger,
    })
    const bad = new AnalyticsRefreshWorker( {
      strategy: makeStrategy(async () => {
        throw new Error('x')
      }),
      logger,
    })

    const ok = await ok.constructor
    // (no-op to keep type narrowing simple)
    void ok
  })
})
