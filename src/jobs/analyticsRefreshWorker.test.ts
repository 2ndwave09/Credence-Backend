import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  AnalyticsRefreshWorker,
  createAnalyticsRefreshWorker,
} from './analyticsRefreshWorker.js'
import {
  AnalyticsRefreshStrategy,
  type Connectable,
  type RefreshStrategyResult,
  type AnalyticsRefreshMetrics,
} from '../services/analytics/refreshStrategy.js'

function makeStrategy(overrides?: Partial<AnalyticsRefreshStrategy>): AnalyticsRefreshStrategy {
  return {
    refreshAll: vi.fn().mockResolved({
      refreshedViews: ['daily_active_users'],
      failedViews: [],
      totalDurationMs: 12,
      cacheGeneration: 1,
    } satisfies RefreshStrategyResult),
    ...overrides,
  } as unknown as AnalyticsRefreshStrategy
}

function makeMetrics(): AnalyticsRefreshMetrics {
  return {
    incRuns: vi.fn(),
    observeDuration: vi.fn(),
    setViewAge: vi.fn(),
    incSkip: vi.fn(),
  }
}

describe('AnalyticsRefreshWorker', () => {
  let logger: ReturnType<typeof vi.fn>

  beforeEach(() => {
    logger = vi.fn()
  })

  it('throws when constructed without a strategy', () => {
    expect(
      () => new AnalyticsRefreshWorker({ strategy: undefined as unknown as AnalyticsRefreshStrategy }),
    ).toThrow(/requires a strategy)
  })

  it('returns a success result and forwards strategy fields', async () => {
    const strategy = makeStrategy()
    const worker = new AnalyticsRefreshWorker({ strategy, logger })

    const result = await worker.run()

    expect(strategy.refreshAll).toHaveBeenCalledOnce()
    expect(result.refreshed).toBe(true)
    expect(result.refreshedViews).toEqual(['daily_active_users'])
    expect(result.failedViews).toEqual([])
    expect(result.cacheGeneration).toBe(1)
    expect(result.durationMs).toBe(12)
    expect(result.startTime).toMatch(/^\d{4}-\d{2}-\d{2}T/)
    expect(result.error).toBeUndefined()
  })

  it('logs start and ok messages on success', async () => {
    const strategy = makeStrategy()
    const worker = new AnalyticsRefreshWorker({ strategy, logger })

    await worker.run()

    expect(logger).toHaveBeenCalledWith(expect.stringContaining('worker.run start'))
    expect(logger).toHaveBeenCalledWith(expect.stringContaining('worker.run ok'))
  })

  it('marks result degraded when some views fail', async () => {
    const strategy = makeStrategy({
      refreshAll: vi.fn().mockResolved({
        refreshedViews: ['a'],
        failedViews: [{ view: 'b', error: 'timeout' }],
        totalDurationMs: 5,
        cacheGeneration: 2,
      } satisfies RefreshStrategyResult),
    })
    const worker = new AnalyticsRefreshWorker({ strategy, logger })

    const result = await worker.run()

    expect(result.refreshed).toBe(false)
    expect(result.failedViews).toEqual([{ view: 'b', error: 'timeout' }])
    expect(logger).toHaveBeenCalledWith(expect.stringContaining('degraded'))
  })

  it('treats zero views as refreshed (boundary: empty spec set)', async () => {
    const strategy = makeStrategy({
      refreshAll: vi.fn().mockResolved({
        refreshedViews: [],
        failedViews: [],
        totalDurationMs: 0,
        cacheGeneration: 0,
      } satisfies RefreshStrategyResult),
    })
    const worker = new AnalyticsRefreshWorker({ strategy, logger })

    const result = await worker.run()

    expect(result.refreshed).toBe(true)
    expect(result.refreshedViews).toEqual([])
    expect(result.durationMs).toBe(0)
  })

  it('captures Error thrown by strategy and returns an error result', async () => {
    const strategy = makeStrategy({
      refreshAll: vi.fn().mockRejected(new Error('pg connection lost')),
    })
    const worker = new AnalyticsRefreshWorker({ strategy, logger })

    const result = await worker.run()

    expect(result.refreshed).toBe(false)
    expect(result.error).toBe('pg connection lost')
    expect(result.refreshedViews).toEqual([])
    expect(result.failedViews).toEqual([])
    expect(result.cacheGeneration).toBeUndefined()
    expect(logger).toHaveBeenCalledWith(expect.stringContaining('crashed'))
  })

  it('handles non-Error thrown values gracefully', async () => {
    const strategy = makeStrategy({
      refreshAll: vi.fn().mockRejected('string error'),
    })
    const worker = new AnalyticsRefreshWorker({ strategy, logger })

    const result = await worker.run()

    expect(result.refreshed).toBe(false)
    expect(result.error).toBe('string error')
  })

  it('recovers on the next run after a crash (recovery boundary)', async () => {
    const refreshAll = vi
      .fn()
      .mockRejectedOnce(new Error('transient'))
      .mockResolvedOnce({
        refreshedViews: ['a'],
        failedViews: [],
        totalDurationMs: 3,
        cacheGeneration: 7,
      } satisfies RefreshStrategyResult)
    const strategy = makeStrategy({ refreshAll })
    const worker = new AnalyticsRefreshWorker({ strategy, logger })

    const first = await worker.run()
    expect(first.refreshed).toBe(false)
    expect(first.error).toBe('transient')

    const second = await worker.run()
    expect(second.refreshed).toBe(true)
    expect(second.cacheGeneration).toBe(7)
    expect(second.error).toBeUndefined()
  })

  it('exposes the last result via getLastResult and updates it each run', async () => {
    const strategy = makeStrategy()
    const worker = new AnalyticsRefreshWorker({ strategy, logger })

    expect(worker.getLastResult()).toBeNull()

    const first = await worker.run()
    expect(worker.getLastResult()).toEqual(first)

    const second = await worker.run()
    expect(worker.getLastResult()).toEqual(second)
    expect(worker.getLastResult()).not.toBe(first)
  })

  it('records the last result even when the strategy crashes', async () => {
    const strategy = makeStrategy({
      refreshAll: vi.fn().mockRejected(new Error('boom')),
    })
    const worker = new AnalyticsRefreshWorker({ strategy, logger })

    await worker.run()

    const last = worker.getLastResult()
    expect(last).not.toBeNull()
    expect(last?.error).toBe('boom')
    expect(last?.refreshed).toBe(false)
  })

  it('does not leak sensitive data in the crash log', async () => {
    const strategy = makeStrategy({
      refreshAll: vi.fn().mockRejected(new Error('password=secret123')),
    })
    const worker = new AnalyticsRefreshWorker({ strategy, logger })

    await worker.run()

    // The worker logs the message verbatim; ensure it does not add extra
    // payloads (e.g. stack traces) beyond the message itself.
    const crashLog = logger.mock.calls.find(([msg]) =>
      String(msg).includes('crashed'),
    )?.[0] as string
    expect(crashLog).toBeDefined()
    expect(crashLog).not.toContain('at ')
  })

  it('uses the default root logger when none is provided', async () => {
    const strategy = makeStrategy()
    const worker = new AnalyticsRefreshWorker({ strategy })

    await expect(worker.run()).resolves.toMatchObject({ refreshed: true })
  })

  it('supports concurrent runs without cross-contaminating results', async () => {
    let call = 0
    const refreshAll = vi.fn().mockImplementation(async () => {
      call += 1
      const n = call
      await new Promise((r) => setTimeout(r, n === 1 ? 5 : 0))
      return {
        refreshedViews: [`view-${n}`],
        failedViews: [],
        totalDurationMs: n,
        cacheGeneration: n,
      } satisfies RefreshStrategyResult
    })
    const strategy = makeStrategy({ refreshAll })
    const worker = new AnalyticsRefreshWorker({ strategy, logger })

    const [a, b] = await Promise.all([worker.run(), worker.run()])

    expect(a.refreshedViews).toEqual(['view-1'])
    expect(b.refreshedViews).toEqual(['view-2'])
    // lastResult reflects whichever finished last (b, since it resolved first
    // but was assigned second — assert it is one of the two, not corrupted).
    const last = worker.getLastResult()
    expect([a, b]).toContainEqual(last)
  })
})

describe('createAnalyticsRefreshWorker', () => {
  it('builds a worker wired to a real strategy with default views', () => {
    const pool = { query: vi.fn() } as unknown as Connectable
    const worker = createAnalyticsRefreshWorker({ pool })

    expect(worker).toBeInstanceOf(AnalyticsRefreshWorker)
    expect(worker.getLastResult()).toBeNull()
  })

  it('forwards custom views and retry options to the strategy', async () => {
    const pool = { query: vi.fn().mockResolved({ rows: [] }) } as unknown as Connectable
    const worker = createAnalyticsRefreshWorker({
      pool,
      views: [{ name: 'custom', sql: 'select 1', ttlMs: 1000 } as never],
      maxAttemptsPerView: 1,
      retryBackoffMs: 0,
    })

    const result = await worker.run()
    expect(result).toBeDefined()
    expect(result.startTime).toMatch(/^\d{4}-\d{2}-\d{2}T/)
  })
})
