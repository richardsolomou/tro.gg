import { describe, expect, it, vi } from 'vitest'
import { retryingStalls } from './publishSpacetimeModule'

const timeout = () => Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' })

describe('retryingStalls', () => {
  it('publishes again after a request that got no answer', async () => {
    const publish = vi.fn<() => Promise<void>>().mockRejectedValueOnce(timeout()).mockResolvedValueOnce()
    await retryingStalls(publish, 3, 0)
    expect(publish).toHaveBeenCalledTimes(2)
  })

  it('does not repeat a publish the server refused', async () => {
    const publish = vi.fn<() => Promise<void>>().mockRejectedValue(new Error('SpacetimeDB migration would break existing clients'))
    await expect(retryingStalls(publish, 3, 0)).rejects.toThrow('would break existing clients')
    expect(publish).toHaveBeenCalledTimes(1)
  })

  it('gives up after the last attempt', async () => {
    const publish = vi.fn<() => Promise<void>>().mockRejectedValue(new TypeError('fetch failed'))
    await expect(retryingStalls(publish, 3, 0)).rejects.toThrow('fetch failed')
    expect(publish).toHaveBeenCalledTimes(3)
  })
})
