import { describe, it, expect, vi } from 'vitest'
import {
  BatchPayoutProcessor,
  getRetryableItems,
  type PayoutItem,
  type PayoutExecutor,
  type PayoutSettlementStore,
} from './batchPayoutProcessor.js'

function makeStore(overrides: Partial<PayoutSettlementStore> = {}): PayoutSettlementStore {
  return {
    upsert: vi.vn().mockResolved({ isDuplicate: false }),
    ...overrides,
  }
}

function makeExecutor(overrides: Partial<PayoutExecutor> = {}): PayoutExecutor {
  return {
    execute: vi.vn().mockResolved(undefined),
    ...overrides,
  }
}

function makeItems(count: number): PayoutItem[] {
  return Array.from({ length: count }, (_, i) => ({
    bondId: `bond-${i}`,
    amount: `${(i + 1) * 100}`,
    transactionHash: `tx-${i}`,
  }))
}

describe('BatchPayoutProcessor', () => {
  it('settles all items when no errors occur', async () => {
    const store = makeStore()
    const executor = makeExecutor()
    const processor = new BatchPayoutProcessor(store, executor)

    const items = makeItems(3)
    const result = await processor.process(items)

    expect(result.total).toBe(3)
    expect(result.settled).toBe(3)
    expect(result.failed).toBe(0)
    expect(result.skipped).toBe(0)
    expect(result.items.every((r) => r.status === 'settled')).toBe(true)
    expect(result.items.every((r) => r.retryEligible === false)).toBe(true)
  })

  it('isolates a single failure from other items', async () => {
    const executor = makeExecutor({
      execute: vi.vn().mockImplementation(async (item: PayoutItem) => {
        if (item.transactionHash === 'tx-1') {
          throw new Error('insufficient funds')
        }
      }),
    })
    const store = makeStore()
    const processor = new BatchPayoutProcessor(store, executor)

    const items = makeItems(3)
    const result = await processor.process(items)

    expect(result.settled).toBe(2)
    expect(result.failed).toBe(1)

    const failedItem = result.items.find((r) => r.transactionHash === 'tx-1')!
    expect(failedItem.status).toBe('failed')
    expect(failedItem.retryEligible).toBe(true)
    expect(failedItem.error).toBe('insufficient funds')

    const successItems = result.items.filter((r) => r.transactionHash !== 'tx-1')
    expect(successItems.every((r) => r.status === 'settled')).toBe(true)
  })

  it('skips duplicate items without marking them as failed', async () => {
    const store = makeStore({
      upsert: vi.vn().mockResolved({ isDuplicate: true }),
    })
    const executor = makeExecutor()
    const processor = new BatchPayoutProcessor(store, executor)

    const items = makeItems(2)
    const result = await processor.process(items)

    expect(result.settled).toBe(0)
    expect(result.failed).toBe(0)
    expect(result.skipped).toBe(2)
    expect(executor.execute).not.toHaveBeenCalled()
  })

  it('marks item as failed and retry-eligible when initial upsert fails', async () => {
    let callCount = 0
    const store = makeStore({
      upsert: vi.vn().mockImplementation(async () => {
        callCount++
        if (callCount === 1) throw new Error('db connection lost')
        return { isDuplicate: false }
      }),
    })
    const executor = makeExecutor()
    const processor = new BatchPayoutProcessor(store, executor)

    const items = makeItems(2)
    const result = await processor.process(items)

    expect(result.failed).toBe(1)
    expect(result.settled).toBe(1)

    const failedItem = result.items.find((r) => r.transactionHash === 'tx-0')!
    expect(failedItem.retryEligible).toBe(true)
  })

  it('marks item as failed when execution succeeds but final status update fails', async () => {
    const store = makeStore({
      upsert: vi.vn().mockImplementation(async (input: any) => {
        // First call (pending) succeeds, second call (settled) fails
        if (input.status === 'settled') {
          throw new Error('status update failed')
        }
        return { isDuplicate: false }
      }),
    })
    const executor = makeExecutor()
    const processor = new BatchPayoutProcessor(store, executor)

    const items = makeItems(1)
    const result = await processor.process(items)

    expect(result.failed).toBe(1)
    const item = result.items[0]
    expect(item.retryEligible).toBe(true)
    expect(item.error).toContain('status update failed')
  })

  it('persists failure status in store when execution fails', async () => {
    const upsertFn = vi.vn().mockResolved({ isDuplicate: false })
    const store = makeStore({ upsert: upsertFn })
    const executor = makeExecutor({
      execute: vi.vn().mockRejected(new Error('timeout')),
    })
    const processor = new BatchPayoutProcessor(store, executor)

    const items = makeItems(1)
    await processor.process(items)

    // Should have been called twice: once for 'pending', once for 'failed'
    expect(upsertFn).toHaveBeenCalledTimes(2)
    const secondCall = upsertFn.mock.calls[1][0]
    expect(secondCall.status).toBe('failed')
  })

  it('handles empty batch gracefully', async () => {
    const store = makeStore()
    const executor = makeExecutor()
    const processor = new BatchPayoutProcessor(store, executor)

    const result = await processor.process([])

    expect(result.total).toBe(0)
    expect(result.settled).toBe(0)
    expect(result.failed).toBe(0)
    expect(result.items).toEqual([])
  })

  it('records accurate aggregate counts with mixed results', async () => {
    let upsertCallIndex = 0
    const store = makeStore({
      upsert: vi.vn().mockImplementation(async () => {
        upsertCallIndex++
        // Make the 3rd upsert call (item index 1, pending) return duplicate
        if (upsertCallIndex === 3) return { isDuplicate: true }
        return { isDuplicate: false }
      }),
    })
    const executor = makeExecutor({
      execute: vi.vn().mockImplementation(async (item: PayoutItem) => {
        if (item.transactionHash === 'tx-2') {
          throw new Error('network error')
        }
      }),
    })
    const processor = new BatchPayoutProcessor(store, executor)

    const items = makeItems(4) // tx-0: success, tx-1: skipped, tx-2: failed, tx-3: success
    const result = await processor.process(items)

    expect(result.total).toBe(4)
    expect(result.settled).toBe(2)
    expect(result.failed).toBe(1)
    expect(result.skipped).toBe(1)
  })

  describe('upfront payload validation (atomic semantics)', () => {
    it('throws error when an item has invalid amount (negative or bad precision) before applying any writes', async () => {
      const store = makeStore()
      const executor = makeExecutor()
      const processor = new BatchPayoutProcessor(store, executor)

      const items = [
        { bondId: 'bond-1', amount: '100', transactionHash: 'tx-1' },
        { bondId: 'bond-2', amount: '-50', transactionHash: 'tx-2' },
      ]

      await expect(processor.process(items)).rejects.toThrow('invalid amount')
      expect(store.upsert).not.toHaveBeenCalled()
      expect(executor.execute).not.toHaveBeenCalled()
    })

    it('throws error when an item has empty or missing transactionHash before applying any writes', async () => {
      const store = makeStore()
      const executor = makeExecutor()
      const processor = new BatchPayoutProcessor(store, executor)

      const items = [
        { bondId: 'bond-1', amount: '100', transactionHash: '' },
      ]

      await expect(processor.process(items)).rejects.toThrow('invalid transactionHash')
      expect(store.upsert).not.toHaveBeenCalled()
      expect(executor.execute).not.toHaveBeenCalled()
    })

    it('throws error when an item has empty bondId before applying any writes', async () => {
      const store = makeStore()
      const executor = makeExecutor()
      const processor = new BatchPayoutProcessor(store, executor)

      const items = [
        { bondId: '', amount: '100', transactionHash: 'tx-1' },
      ]

      await expect(processor.process(items)).rejects.toThrow('invalid bondId')
      expect(store.upsert).not.toHaveBeenCalled()
      expect(executor.execute).not.toHaveBeenCalled()
    })
  })

  describe('boundary conditions', () => {
    it('throws when payload is not an array', async () => {
      const processor = new BatchPayoutProcessor(makeStore(), makeExecutor())
      await expect(processor.process(null as unknown as PayoutItem[])).rejects.toThrow(
        'must be an array',
      )
    })

    it('throws when an item is null', async () => {
      const processor = new BatchPayoutProcessor(makeStore(), makeExecutor())
      await expect(processor.process([null as unknown as PayoutItem])).rejects.toThrow(
        'must be a valid payout item object',
      )
    })

    it('accepts amount of 0 and maximum amount 1e18', async () => {
      const store = makeStore()
      const executor = makeExecutor()
      const processor = new BatchPayoutProcessor(store, executor)

      const items: PayoutItem[] = [
        { bondId: 'bond-0', amount: '0', transactionHash: 'tx-0' },
        { bondId: 'bond-1', amount: '1000000000000000000', transactionHash: 'tx-1' },
      ]

      const result = await processor.process(items)
      expect(result.settled).toBe(2)
    })

    it('rejects amount exceeding 1e18', async () => {
      const processor = new BatchPayoutProcessor(makeStore(), makeExecutor())
      const items = [{ bondId: 'bond-1', amount: '1e19', transactionHash: 'tx-1' }]
      await expect(processor.process(items)).rejects.toThrow('valid non-negative numeric string')
    })

    it('rejects amount with more than 18 decimal places', async () => {
      const processor = new BatchPayoutProcessor(makeStore(), makeExecutor())
      const items = [
        { bondId: 'bond-1', amount: '1.0000000000000000001', transactionHash: 'tx-1' },
      ]
      await expect(processor.process(items)).rejects.toThrow('invalid amount')
    })

    it('rejects transactionHash longer than 128 characters', async () => {
      const processor = new BatchPayoutProcessor(makeStore(), makeExecutor())
      const items = [{ bondId: 'bond-1', amount: '100', transactionHash: 'x'.repeat(129) }]
      await expect(processor.process(items)).rejects.toThrow('invalid transactionHash')
    })

    it('rejects invalid settledAt Date', async () => {
      const processor = new BatchPayoutProcessor(makeStore(), makeExecutor())
      const items = [
        {
          bondId: 'bond-1',
          amount: '100',
          transactionHash: 'tx-1',
          settledAt: new Date(NaN),
        },
      ]
      await expect(processor.process(items)).rejects.toThrow('invalid settledAt')
    })

    it('enforces maxBatchSize and rejects oversized payloads', async () => {
      const processor = new BatchPayoutProcessor(makeStore(), makeExecutor(), {
        maxBatchSize: 2,
      })
      await expect(processor.process(makeItems(3))).rejects.toThrow('maximum batch size')
    })

    it('rejects invalid maxBatchSize option', () => {
      expect(
        () => new BatchPayoutProcessor(makeStore(), makeExecutor(), { maxBatchSize: 0 }),
      ).toThrow('maxBatchSize must be a positive integer')
    })
  })

  describe('duplicate transaction hashes within a batch', () => {
    it('executes only the first occurrence and skips the rest', async () => {
      const store = makeStore()
      const executor = makeExecutor()
      const processor = new BatchPayoutProcessor(store, executor)

      const items: PayoutItem[] = [
        { bondId: 'bond-0', amount: '100', transactionHash: 'tx-dup' },
        { bondId: 'bond-1', amount: '200', transactionHash: 'tx-dup' },
      ]

      const result = await processor.process(items)

      expect(result.total).toBe(2)
      expect(result.settled).toBe(1)
      expect(result.skipped).toBe(1)
      expect(executor.execute).toHaveBeenCalledOnce()
      expect(store.upsert).toHaveBeenCalledTimes(2) // pending + settled for the first only
    })
  })

  describe('concurrency guard', () => {
    it('rejects a concurrent process call on the same instance', async () => {
      let resolveExecute: (() => void) | undefined
      const gate = new Promise<void>((resolve) => {
        resolveExecute = resolve
      })
      const executor = makeExecutor({
        execute: vi.vn().mockImplementation(async () => {
          await gate
        }),
      })
      const processor = new BatchPayoutProcessor(makeStore(), executor)

      const first = processor.process(makeItems(1))
      await expect(processor.process(makeItems(1))).rejects.toThrow('already processing')
      resolveExecute && resolveExecute()
      await first
    })

    it('allows a subsequent call after the first completes', async () => {
      const processor = new BatchPayoutProcessor(makeStore(), makeExecutor())
      await processor.process(makeItems(1))
      const result = await processor.process(makeItems(1))
      expect(result.settled).toBe(1)
    })

    it('releases the guard even when validation throws', async () => {
      const processor = new BatchPayoutProcessor(makeStore(), makeExecutor())
      await expect(processor.process(null as unknown as PayoutItem[])).rejects.toThrow()
      const result = await processor.process(makeItems(1))
      expect(result.settled).toBe(1)
    })
  })

  describe('recovery and retry', () => {
    it('returns retryable items and lets a retry settle them', async () => {
      let failTxOne = true
      const executor = makeExecutor({
        execute: vi.vn().mockImplementation(async (item: PayoutItem) => {
          if (item.transactionHash === 'tx-1' && failTxOne) {
            throw new Error('network glitch')
          }
        }),
      })
      const processor = new BatchPayoutProcessor(makeStore(), executor)

      const items = makeItems(3)
      const first = await processor.process(items)
      expect(first.failed).toBe(1)

      const retryable = getRetryableItems(items, first)
      expect(retryable.map((i) => i.transactionHash)).toEqual(['tx-1'])

      failTxOne = false
      const second = await processor.process(retryable)
      expect(second.settled).toBe(1)
      expect(second.failed).toBe(0)
    })

    it('keeps an item retry-eligible when the failure status write also fails', async () => {
      const upserFn = vi.vn().mockImplementation(async (input: any) => {
        if (input.status === 'failed') throw new Error('store unavailable')
        return { isDuplicate: false }
      })
      const executor = makeExecutor({
        execute: vi.vn().mockRejected(new Error('timeout')),
      })
      const processor = new BatchPayoutProcessor(makeStore({ upsert: upsertFn }), executor)

      const result = await processor.process(makeItems(1))
      expect(result.failed).toBe(1)
      expect(result.items[0].retryEligible).toBe(true)
    })
  })

  describe('observability', () => {
    it('logs batch summary without exposing amounts', async () => {
      const logs: string[] = []
      const processor = new BatchPayoutProcessor(makeStore(), makeExecutor(), {
        logger: (m) => logs.push(m),
      })
      await processor.process(makeItems(2))
      const summary = logs.find((m) => m.startsWith('Batch complete'))
      expect(summary).toBeDefined()
      expect(summary).not.toContain('100')
    })
  })
})

describe('getRetryableItems', () => {
  it('returns only items that are retry-eligible', () => {
    const items = makeItems(3)
    const result = {
      total: 3,
      settled: 1,
      failed: 2,
      skipped: 0,
      duration: 100,
      startTime: new Date().toISOString(),
      items: [
        { bondId: 'bond-0', transactionHash: 'tx-0', status: 'settled' as const, retryEligible: false },
        { bondId: 'bond-1', transactionHash: 'tx-1', status: 'failed' as const, retryEligible: true, error: 'err' },
        { bondId: 'bond-2', transactionHash: 'tx-2', status: 'failed' as const, retryEligible: true, error: 'err' },
      ],
    }

    const retryable = getRetryableItems(items, result)
    expect(retryable).toHaveLength(2)
    expect(retryable.map((i) => i.transactionHash)).toEqual(['tx-1', 'tx-2'])
  })

  it('returns empty array when nothing is retryable', () => {
    const items = makeItems(2)
    const result = {
      total: 2,
      settled: 2,
      failed: 0,
      skipped: 0,
      duration: 50,
      startTime: new Date().toISOString(),
      items: [
        { bondId: 'bond-0', transactionHash: 'tx-0', status: 'settled' as const, retryEligible: false },
        { bondId: 'bond-1', transactionHash: 'tx-1', status: 'settled' as const, retryEligible: false },
      ],
    }

    expect(getRetryableItems(items, result)).toEqual([])
  })

  it('preserves original ordering of retryable items', () => {
    const items: PayoutItem[] = [
      { bondId: 'bond-0', amount: '100', transactionHash: 'tx-0' },
      { bondId: 'bond-1', amount: '100', transactionHash: 'tx-1' },
      { bondId: 'bond-2', amount: '100', transactionHash: 'tx-2' },
    ]
    const result = {
      total: 3,
      settled: 0,
      failed: 3,
      skipped: 0,
      duration: 1,
      startTime: new Date().toISOString(),
      items: [
        { bondId: 'bond-2', transactionHash: 'tx-2', status: 'failed' as const, retryEligible: true },
        { bondId: 'bond-0', transactionHash: 'tx-0', status: 'failed' as const, retryEligible: true },
      ],
    }
    expect(getRetryableItems(items, result).map((i) => i.transactionHash)).toEqual(['tx-0', 'tx-2'])
  })
})
