import { describe, expect, it } from "bun:test"
import { getCacheReadPrice, splitCost, calcCacheHitRate } from "./cost"

// ─── getCacheReadPrice ─────────────────────────────────────────────────────────

describe("getCacheReadPrice", () => {
  it("returns the cache.read price when provider has cache pricing", () => {
    const providers = [
      {
        id: "test-provider",
        name: "Test Provider",
        models: {
          "claude-sonnet-4": {
            cost: {
              input: 3,
              output: 15,
              cache: { read: 0.3, write: 3 },
            },
          },
        },
      },
    ]
    expect(getCacheReadPrice("claude-sonnet-4", providers)).toBe(0.3)
  })

  it("returns 0 when provider has no cache.read pricing", () => {
    const providers = [
      {
        id: "test-provider",
        name: "Test Provider",
        models: {
          "gpt-4o": {
            cost: {
              input: 2.5,
              output: 10,
              // no cache field
            },
          },
        },
      },
    ]
    expect(getCacheReadPrice("gpt-4o", providers)).toBe(0)
  })

  it("returns 0 when provider has cache but no read price", () => {
    const providers = [
      {
        id: "test-provider",
        name: "Test Provider",
        models: {
          "gpt-4o": {
            cost: {
              input: 2.5,
              output: 10,
              cache: { write: 2.5 }, // no read
            },
          },
        },
      },
    ]
    expect(getCacheReadPrice("gpt-4o", providers)).toBe(0)
  })

  it("returns 0 when model is not found in provider", () => {
    const providers = [
      {
        id: "test-provider",
        name: "Test Provider",
        models: {
          "claude-sonnet-4": {
            cost: {
              input: 3,
              output: 15,
              cache: { read: 0.3, write: 3 },
            },
          },
        },
      },
    ]
    expect(getCacheReadPrice("nonexistent-model", providers)).toBe(0)
  })

  it("returns 0 when model has no cost config", () => {
    const providers = [
      {
        id: "test-provider",
        name: "Test Provider",
        models: {
          "free-model": {
            // no cost field
          },
        },
      },
    ]
    expect(getCacheReadPrice("free-model", providers)).toBe(0)
  })

  it("returns 0 for empty providers array", () => {
    expect(getCacheReadPrice("any-model", [])).toBe(0)
  })

  it("picks the first provider's price when multiple match", () => {
    const providers = [
      {
        id: "provider-a",
        name: "Provider A",
        models: {
          "shared-model": {
            cost: {
              input: 3,
              output: 15,
              cache: { read: 0.3, write: 3 },
            },
          },
        },
      },
      {
        id: "provider-b",
        name: "Provider B",
        models: {
          "shared-model": {
            cost: {
              input: 2.5,
              output: 10,
              cache: { read: 0.25, write: 2.5 },
            },
          },
        },
      },
    ]
    // Should return price from provider-a (first match)
    expect(getCacheReadPrice("shared-model", providers)).toBe(0.3)
  })

  it("handles cache.read of 0 explicitly", () => {
    const providers = [
      {
        id: "test-provider",
        name: "Test Provider",
        models: {
          "zero-cache-model": {
            cost: {
              input: 1,
              output: 4,
              cache: { read: 0, write: 1 },
            },
          },
        },
      },
    ]
    expect(getCacheReadPrice("zero-cache-model", providers)).toBe(0)
  })

  it("handles null models gracefully", () => {
    const providers = [
      {
        id: "test-provider",
        name: "Test Provider",
        models: null,
      },
    ] as any
    expect(getCacheReadPrice("any-model", providers)).toBe(0)
  })

  it("skips providers with no models property", () => {
    const providers = [
      {
        id: "broken-provider",
        name: "Broken",
        // no models key
      },
    ] as any
    expect(getCacheReadPrice("any-model", providers)).toBe(0)
  })
})

// ─── Cache hit rate formula ────────────────────────────────────────────────────

describe("cacheHitRate", () => {
  // Inline formula: cacheRead / (cacheRead + nonCached) * 100, rounded
  // Returns null when total is 0

  function calcHitRate(cacheRead: number, nonCached: number): number | null {
    const total = cacheRead + nonCached
    if (total === 0) return null
    return Math.round((cacheRead / total) * 100)
  }

  it("returns 0% when no cache reads", () => {
    expect(calcHitRate(0, 100)).toBe(0)
  })

  it("returns 100% when all input is cached", () => {
    expect(calcHitRate(100, 0)).toBe(100)
  })

  it("returns 50% when half is cached", () => {
    expect(calcHitRate(50, 50)).toBe(50)
  })

  it("returns 25% when quarter is cached", () => {
    expect(calcHitRate(25, 75)).toBe(25)
  })

  it("returns null when both are zero", () => {
    expect(calcHitRate(0, 0)).toBeNull()
  })

  it("rounds to nearest integer", () => {
    // 1/3 ≈ 33.333% → rounds to 33
    expect(calcHitRate(1, 2)).toBe(33)
    // 2/3 ≈ 66.666% → rounds to 67
    expect(calcHitRate(2, 1)).toBe(67)
  })

  it("handles large numbers without overflow", () => {
    const result = calcHitRate(800_000, 200_000)
    expect(result).toBe(80)
  })

  it("handles zero cache read with non-zero input", () => {
    expect(calcHitRate(0, 500)).toBe(0)
  })

  it("handles tiny values close to zero", () => {
    expect(calcHitRate(1, 999_999)).toBe(0)
  })

  it("handles nearly all cached", () => {
    expect(calcHitRate(999_999, 1)).toBe(100)
  })
})

// ─── Cache savings formula ─────────────────────────────────────────────────────

describe("cacheSavings", () => {
  // Formula: totalCacheReadTokens * cacheReadPrice / 1_000_000
  // Returns null when price is 0, or savings <= 0

  function calcSavings(cacheReadTokens: number, cacheReadPrice: number): number | null {
    if (cacheReadPrice === 0) return null
    const savings = cacheReadTokens * cacheReadPrice / 1_000_000
    if (savings <= 0) return null
    return savings
  }

  it("computes savings correctly for 100k cached tokens at $0.30/M tokens", () => {
    // 100_000 * 0.30 / 1_000_000 = $0.03
    const result = calcSavings(100_000, 0.30)
    expect(result).toBeCloseTo(0.03, 6)
  })

  it("computes savings correctly for 1M cached tokens at $0.30/M tokens", () => {
    // 1_000_000 * 0.30 / 1_000_000 = $0.30
    const result = calcSavings(1_000_000, 0.30)
    expect(result).toBeCloseTo(0.30, 6)
  })

  it("computes savings correctly for 50k cached tokens at $1.50/M tokens", () => {
    // 50_000 * 1.50 / 1_000_000 = $0.075
    const result = calcSavings(50_000, 1.50)
    expect(result).toBeCloseTo(0.075, 6)
  })

  it("returns null when price is 0", () => {
    expect(calcSavings(100_000, 0)).toBeNull()
  })

  it("returns null when savings is 0 (0 cached tokens)", () => {
    expect(calcSavings(0, 0.30)).toBeNull()
  })

  it("returns null when savings would be <= 0", () => {
    // -1 tokens shouldn't happen in practice, but safeguard
    expect(calcSavings(-100, 0.30)).toBeNull()
  })

  it("handles zero cached tokens with non-zero price", () => {
    expect(calcSavings(0, 0.50)).toBeNull()
  })

  it("handles large cached token counts", () => {
    // 10_000_000 * 0.15 / 1_000_000 = $1.50
    const result = calcSavings(10_000_000, 0.15)
    expect(result).toBeCloseTo(1.50, 6)
  })

  it("handles very small savings (just above zero)", () => {
    // 1 token at $0.0001/M → 1 * 0.0001 / 1_000_000 = $1e-10 ≈ 0
    // Still above 0 so should return a non-null value
    const result = calcSavings(1, 0.0001)
    expect(result).not.toBeNull()
    expect(result!).toBeGreaterThan(0)
  })
})

// ─── splitCost (regression: cache-read pricing integration) ────────────────────

describe("splitCost with cache.read pricing", () => {
  it("uses cacheReadPrice in input weight when provider has cache.read cost", () => {
    // deltaInput=100, deltaCacheRead=900, deltaOutput=500, deltaCost=$0.15
    // inputPrice=$3/M, cacheReadPrice=$0.30/M, outputPrice=$15/M
    // inputWeight   = (100 * 3 + 900 * 0.30) / 1_000_000 = (300+270)/1e6 = 570/1e6
    // outputWeight  = (500 * 15) / 1_000_000 = 7500/1e6
    // totalWeight   = 8070/1e6
    // inputCost     = 0.15 * 570/8070 ≈ 0.010594...
    // outputCost    = 0.15 * 7500/8070 ≈ 0.139405...
    const result = splitCost(100, 900, 500, 0.15, "claude-sonnet-4", [
      {
        id: "anthropic",
        name: "Anthropic",
        models: {
          "claude-sonnet-4": {
            cost: { input: 3, output: 15, cache: { read: 0.30, write: 3 } },
          },
        },
      },
    ])
    expect(result.inputCost).toBeCloseTo(0.01059, 4)
    expect(result.outputCost).toBeCloseTo(0.13941, 4)
    expect(result.inputCost + result.outputCost).toBeCloseTo(0.15, 6)
  })

  it("ignores cacheReadPrice when cache.read is 0", () => {
    // deltaInput=500, deltaCacheRead=0, deltaOutput=500, deltaCost=$0.50
    // cacheReadPrice=0, inputPrice=$10/M, outputPrice=$30/M
    // inputWeight   = (500 * 10 + 0 * 0) / 1_000_000 = 5000/1e6
    // outputWeight  = (500 * 30) / 1_000_000 = 15000/1e6
    // totalWeight   = 20000/1e6
    // inputCost     = 0.50 * 5000/20000 = 0.125
    // outputCost    = 0.50 * 15000/20000 = 0.375
    const result = splitCost(500, 0, 500, 0.50, "expensive-model", [
      {
        id: "test",
        name: "Test",
        models: {
          "expensive-model": {
            cost: { input: 10, output: 30 },
          },
        },
      },
    ])
    expect(result.inputCost).toBeCloseTo(0.125, 4)
    expect(result.outputCost).toBeCloseTo(0.375, 4)
  })
})

// ─── splitCost edge cases ───────────────────────────────────────────────────────

describe("splitCost edge cases", () => {
  it("returns zero costs when all deltas are zero", () => {
    const result = splitCost(0, 0, 0, 0, "model", [])
    expect(result.inputCost).toBe(0)
    expect(result.outputCost).toBe(0)
  })

  it("handles zero deltaCost with non-zero tokens", () => {
    // streaming message where cost hasn't been assigned yet
    const result = splitCost(1000, 5000, 500, 0, "model", [
      { id: "p", name: "p", models: { "model": { cost: { input: 3, output: 15, cache: { read: 0.3 } } } } }
    ])
    expect(result.inputCost).toBe(0)
    expect(result.outputCost).toBe(0)
  })

  it("falls back to token-proportional when no pricing", () => {
    // deltaInput=100, deltaCacheRead=900, deltaOutput=500, deltaCost=$0.15
    // total tokens = 1500, input share = 1000/1500, output share = 500/1500
    const result = splitCost(100, 900, 500, 0.15, "unknown-model", [
      { id: "p", name: "p", models: {} }
    ])
    expect(result.inputCost).toBeCloseTo(0.10, 6) // 0.15 * 1000/1500
    expect(result.outputCost).toBeCloseTo(0.05, 6) // 0.15 * 500/1500
    expect(result.inputCost + result.outputCost).toBeCloseTo(0.15, 6)
  })

  it("handles model not found in any provider", () => {
    const result = splitCost(100, 0, 500, 0.25, "nonexistent", [
      { id: "p", name: "p", models: { "other": { cost: { input: 3, output: 15 } } } }
    ])
    // Falls back to token proportional: 100/600 vs 500/600
    expect(result.inputCost).toBeCloseTo(0.04167, 4)
    expect(result.outputCost).toBeCloseTo(0.20833, 4)
  })

  it("handles empty providers array with token proportional fallback", () => {
    const result = splitCost(100, 0, 500, 0.30, "model", [])
    expect(result.inputCost).toBeCloseTo(0.05, 6)  // 0.30 * 100/600
    expect(result.outputCost).toBeCloseTo(0.25, 6) // 0.30 * 500/600
  })
})

// ─── Token accumulation logic ───────────────────────────────────────────────────

describe("token accumulation logic", () => {
  // Simulates the delta-based accumulation used in sidebar.tsx
  // Uses processedAssistantMessages Map to track per-message snapshots

  it("accumulates deltas correctly across multiple messages", () => {
    const snapshots = new Map<string, { input: number; cacheRead: number; output: number; cost: number }>()
    let totalCacheRead = 0
    let totalNonCachedInput = 0
    let totalOutput = 0

    // Message 1: new message, all deltas positive
    const m1 = { id: "msg-1", input: 5000, cacheRead: 50000, output: 8000, cost: 0.15 }
    const prev1 = snapshots.get(m1.id) ?? { input: 0, cacheRead: 0, output: 0, cost: 0 }
    const d1Input = Math.max(0, m1.input - prev1.input)
    const d1CacheRead = Math.max(0, m1.cacheRead - prev1.cacheRead)
    const d1Output = Math.max(0, m1.output - prev1.output)
    snapshots.set(m1.id, { input: m1.input, cacheRead: m1.cacheRead, output: m1.output, cost: m1.cost })
    totalCacheRead += d1CacheRead
    totalNonCachedInput += d1Input
    totalOutput += d1Output

    expect(totalCacheRead).toBe(50000)
    expect(totalNonCachedInput).toBe(5000)
    expect(totalOutput).toBe(8000)

    // Message 2: new message
    const m2 = { id: "msg-2", input: 3000, cacheRead: 45000, output: 6000, cost: 0.10 }
    const prev2 = snapshots.get(m2.id) ?? { input: 0, cacheRead: 0, output: 0, cost: 0 }
    totalCacheRead += Math.max(0, m2.cacheRead - prev2.cacheRead)
    totalNonCachedInput += Math.max(0, m2.input - prev2.input)
    totalOutput += Math.max(0, m2.output - prev2.output)
    snapshots.set(m2.id, { input: m2.input, cacheRead: m2.cacheRead, output: m2.output, cost: m2.cost })

    expect(totalCacheRead).toBe(95000)
    expect(totalNonCachedInput).toBe(8000)
    expect(totalOutput).toBe(14000)
    expect(Math.round(totalCacheRead / (totalCacheRead + totalNonCachedInput) * 100)).toBe(92) // ~92%
  })

  it("does not double-count when same message updates with higher tokens (streaming)", () => {
    const snapshots = new Map<string, { input: number; cacheRead: number; output: number; cost: number }>()
    let totalOutput = 0

    // First chunk
    const chunk1 = { id: "msg-stream", output: 50 }
    const prev1 = snapshots.get(chunk1.id) ?? { input: 0, cacheRead: 0, output: 0, cost: 0 }
    totalOutput += Math.max(0, chunk1.output - prev1.output)
    snapshots.set(chunk1.id, { input: 0, cacheRead: 0, output: chunk1.output, cost: 0 })
    expect(totalOutput).toBe(50)

    // Second chunk (streaming update — same msgId, more output tokens)
    const chunk2 = { id: "msg-stream", output: 200 }
    const prev2 = snapshots.get(chunk2.id)!
    totalOutput += Math.max(0, chunk2.output - prev2.output)
    snapshots.set(chunk2.id, { ...prev2, output: chunk2.output })
    expect(totalOutput).toBe(200) // 50 + 150, NOT 50 + 200

    // Third chunk
    const chunk3 = { id: "msg-stream", output: 8000 }
    const prev3 = snapshots.get(chunk3.id)!
    totalOutput += Math.max(0, chunk3.output - prev3.output)
    expect(totalOutput).toBe(8000)
  })

  it("reset clears all accumulated values", () => {
    let totalCacheRead = 95000
    let totalNonCachedInput = 8000
    let totalOutput = 14000

    // Reset
    totalCacheRead = 0
    totalNonCachedInput = 0
    totalOutput = 0

    expect(totalCacheRead).toBe(0)
    expect(totalNonCachedInput).toBe(0)
    expect(totalOutput).toBe(0)
  })

  it("handles cache-only conversation (all input from cache, no fresh input)", () => {
    let totalCacheRead = 0
    let totalNonCachedInput = 0

    // Message with only cache reads, no fresh input
    const msg = { id: "msg-cache-only", input: 0, cacheRead: 60000, output: 5000, cost: 0.05 }
    totalCacheRead += msg.cacheRead
    totalNonCachedInput += msg.input

    expect(totalCacheRead).toBe(60000)
    expect(totalNonCachedInput).toBe(0)
    expect(Math.round(totalCacheRead / (totalCacheRead + totalNonCachedInput) * 100)).toBe(100) // 100% cache hit
  })
})

// ─── calcCacheHitRate ──────────────────────────────────────────────────────────

describe("calcCacheHitRate", () => {
  it("returns null when both inputs are 0", () => {
    expect(calcCacheHitRate(0, 0)).toBeNull()
  })

  it("returns 0 when cacheRead is 0 and nonCachedInput is positive", () => {
    expect(calcCacheHitRate(0, 100)).toBe(0)
    expect(calcCacheHitRate(0, 1)).toBe(0)
  })

  it("returns 100 when nonCachedInput is 0 and cacheRead is positive", () => {
    expect(calcCacheHitRate(100, 0)).toBe(100)
    expect(calcCacheHitRate(1, 0)).toBe(100)
  })

  it("returns 50 when cacheRead equals nonCachedInput", () => {
    expect(calcCacheHitRate(50, 50)).toBe(50)
    expect(calcCacheHitRate(1000, 1000)).toBe(50)
  })

  it("rounds to nearest integer", () => {
    // 1 / 3 ≈ 33.333% → 33
    expect(calcCacheHitRate(1, 2)).toBe(33)
    // 2 / 3 ≈ 66.666% → 67
    expect(calcCacheHitRate(2, 1)).toBe(67)
  })

  it("handles rounding behavior at a boundary that rounds to .5", () => {
    // 1 / 200 * 100 = 0.5% → rounds to 1%
    expect(calcCacheHitRate(1, 199)).toBe(1)
    // 3 / 200 * 100 = 1.5% → rounds to 2%
    expect(calcCacheHitRate(3, 197)).toBe(2)
    // 1 / 202 * 100 ≈ 0.495% → rounds to 0%
    expect(calcCacheHitRate(1, 201)).toBe(0)
  })
})
