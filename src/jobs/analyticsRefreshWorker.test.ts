import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  AnalyticsRefreshWorker,
  createAnalyticsRefreshWorker,
} from './analyticsRefreshWorker.js'
import type {
  AnalyticsRefreshStrategy,
  AnalyticsRefreshMetrics,
  RefreshStrategyResult,
} from '../services/analytics/refreshStrategy.js'

function makeStrategy(overrides?: Partial<{ refreshAll: () => Promise<RefreshStrategyResult> }>): AnalyticsRefreshStrategy {
  const base: RefreshStrategyResult = {
    refreshedViews: ['view_a'],
    failedViews: [],
    totalDurationMs: 12,
    cacheGeneration: 7,
  }
  return {
    refreshAll: vi.vn().mockResolved(base),
    ...overrides,
  } as unknown as AnalyticsRefreshStrategy
}

function makeMetrics(): AnalyticsRefreshMetrics {
  return {
    incViewRefresh: vi.fn(),
    observeViewDuration: vi.fn(),
    incViewFailure: vi.fn(),
    setViewAge: vi.fn(),
  } as unknown as AnalyticsRefreshMetrics
}

describe('AnalyticsRefreshWorker', () => {
  let logger: ReturnType<typeof vi.fn>

  beforeEach(() => {
    logger = vi.fn()
  })

  it('throws when constructed without a strategy', () => {
    expect(
      () => new AnalyticsRefreshWorker({} as unknown as never),
    ).toThrow('AnalyticsRefreshWorker requires a strategy')
  })

  it('returns a success result and records the last result', async () => {
    const strategy = makeStrategy()
    const worker = new AnalyticsRefreshWorker({ strategy, logger })

    expect(worker.getLastResult()).toBeNull()

    const result = await worker.run()

    expect(strategy.refreshAll).toHaveBeenCalledOnce()
    expect(result.refreshed).toBe(true)
    expect(result.durationMs).toBe12)
    expect(result.refreshedViews).toEqual(['view_a'])
    expect(result.failedViews).toEqual([])
    expect(result.cacheGeneration).toBe(7)
    expect(result.startTime).toMatch(/^\d{4}-\d{2}-\d{2}T/)
    expect(result.error).toBeUndefined()
    expect(worker.getLastResult()).toEqual(result)
  })

  it('logs start and ok messages', async () => {
    const strategy = makeStrategy()
    const worker = new AnalyticsRefreshWorker({ strategy, logger })

    await worker.run()

    expect(logger).toHaveBeenCalledWith(expect.stringContaining('worker.run start'))
    expect(logger).toHaveBeenCalledWith(expect.stringContaining('worker.run ok'))
  })

  it('marks the run as degraded when any view failed', async () => {
    const strategy = makeStrategy({
      refreshAll: vi.vn().mockResolved({
        refreshedViews: ['view_a'],
        failedViews: [{ view: 'view_b', error: 'timeout' }],
        totalDurationMs: 42,
        cacheGeneration: 8,
      }),
    })
    const worker = new AnalyticsRefreshWorker({ strategy, logger })

    const result = await worker.run()

    expect(result.refreshed).toBe(false)
    expect(result.failedViews).toEqual([{ view: 'view_b', error: 'timeout' }])
    expect(logger).toHaveBeenCalledWith(expect.stringContaining('worker.run degraded'))
  })

  it('returns an error result when the strategy throws', async () => {
    const strategy = makeStrategy({
      refreshAll: vi.vn().mockRejected(new Error('pg connection lost')),
    })
    const worker = new AnalyticsRefreshWorker({ strategy, logger })

    const result = await worker.run()

    expect(result.refreshed).toBe(false)
    expect(result.error).toBe('pg connection lost')
    expect(result.refreshedViews).toEqual([])
    expect(result.failedViews).toEqual([])
    expect(worker.getLastResult()).toEqual(result)
    expect(logger).toHaveBeenCalledWith(expect.stringContaining('worker.run crashed'))
  })

  it('handles non-Error thrown values gracefully', async () => {
    const strategy = makeStrategy({
      refreshAll: vi.vn().mockRejected('string error'),
    })
    const worker = new AnalyticsRefreshWorker({ strategy, logger })

    const result = await worker.run()

    expect(result.refreshed).toBe(false)
    expect(result.error).toBe('string error')
  })

  it('recovers after a crash on the next run', async () => {
    const refreshAll = vi.fn()
      .mockRejectedOnce(new Error('pg connection lost'))
      .mockResolved({
        refreshedViews: ['view_a'],
        failedViews: [],
        totalDurationMs: 5,
        cacheGeneration: 9,
      })
    const strategy = makeStrategy({ refreshAll })
    const worker = new AnalyticsRefreshWorker({ strategy, logger })

    const first = await worker.run()
    expect(first.refreshed).toBe(false)
    expect(first.error).toBeTruthy()

    const second = await worker.run()
    expect(second.refreshed).toBe(true)
    expect(second.error).toBeUndefined()
    expect(second.cacheGeneration).toBe(9)
    expect(worker.getLastResult()).toEqual(second)
  })

  it('treats an empty refresh as successful', async () => {
    const strategy = makeStrategy({
      refreshAll: vi.vn().mockResolved({
        refreshedViews: [],
        failedViews: [],
        totalDurationMs: 0,
        cacheGeneration: 1,
      }),
    })
    const worker = new AnalyticsRefreshWorker({ strategy, logger })

    const result = await worker.run()

    expect(result.refreshed).toBe(true)
    expect(result.refreshedViews).toEqual([])
    expect(result.failedViews).toEqual([])
  })

  it('surfaces a cache generation of zero without treating it as failure', async () => {
    const strategy = makeStrategy({
      refreshAll: vi.vn().mockResolved({
        refreshedViews: ['view_a'],
        failedViews: [],
        totalDurationMs: 1,
        cacheGeneration: 0,
      }),
    })
    const worker = new AnalyticsRefreshWorker({ strategy, logger })

    const result = await worker.run()

    expect(result.refreshed).toBe(true)
    expect(result.cacheGeneration).toBe(0)
  })

  it('preserves the last result when a concurrent run is started', async () => {
    let resolveFirst: ((r: RefreshStrategyResult) => void) | undefined
    const firstPromise = new Promise<RefreshStrategyResult>((resolve) => {
      resolveFirst = resolve
    })
    const refreshAll = vi.fn()
      .mockImplementationOnce(() => firstPromise)
      .mockResolved({
        refreshedViews: ['view_b'],
        failedViews: [],
        totalDurationMs: 3,
        cacheGeneration: 2,
      })
    const strategy = makeStrategy({ refreshAll })
    const worker = new AnalyticsRefreshWorker({ strategy, logger })

    const inflight = worker.run()
    const second = await worker.run()

    expect(second.cacheGeneration).toBe(2)
    expect(worker.getLastResult()).toEqual(second)

    resolveFirst!({
      refreshedViews: ['view_a'],
      failedViews: [],
      totalDurationMs: 10,
      cacheGeneration: 1,
    })
    const first = await inflight

    expect(first.cacheGeneration).toBe(1)
    expect(worker.getLastResult()).toEqual(first)
  })

  it('returns a fresh result object on each invocation', async () => {
    const strategy = makeStrategy()
    const worker = new AnalyticsRefreshWorker({ strategy, logger })

    const a = await worker.run()
    const b = await worker.run()

    expect(a).not.toBe(b)
    expect(a).toEqual({ ...a, refreshedViews: a.refreshedViews })
  })

  it('records success metrics when metrics are provided', async () => {
    const strategy = makeStrategy()
    const metrics = makeMetrics()
    const worker = new AnalyticsRefreshWorker({ strategy, metrics, logger })

    await worker.run()

    expect(metrics.incViewRefresh).toHaveBeenCalled()
  })

  it('returns error result and records error metric when refresh throws', async () => {
    const strategy = makeStrategy({
      refreshAll: vi.vn().mockRejected(new Error('pg connection lost')),
    })
    const metrics = makeMetrics()
    const worker = new AnalyticsRefreshWorker({ strategy, metrics, logger })

    const result = await worker.run()

    expect(result.refreshed).toBe(false)
    expect(result.error).toBe('pg connection lost')
  })

  it('uses the default logger when none is provided', async () => {
    const strategy = makeStrategy()
    const worker = new AnalyticsRefreshWorker({ strategy })

    await expect(worker.run()).resolves.toMatchObject({ refreshed: true })
  })

})

describe('createAnalyticsRefreshWorker', () => {
  it('returns a worker wired to the provided pool', () => {
    const pool = { query: vi.vn().mockResolved({ rows: [], rowCount: 0 }) }
    const worker = createAnalyticsRefreshWorker({ pool: pool as never, logger: vi.fn() })

    expect(worker).toBeInstanceOf(AnalyticsRefreshWorker)
    expect(worker.getLastResult()).toBeNull()
  })
})
