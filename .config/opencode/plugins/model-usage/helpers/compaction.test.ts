import { describe, expect, it } from "bun:test"
import { summarizeCompactions, type CompactionEvent } from "./compaction"

// ─── summarizeCompactions ───────────────────────────────────────────────────

describe("summarizeCompactions", () => {
  it("returns count 0 and reductionTokens 0 for an empty array", () => {
    expect(summarizeCompactions([])).toEqual({ count: 0, reductionTokens: 0 })
  })

  it("handles a single event with before > after and computes correct positive reduction", () => {
    const events: CompactionEvent[] = [
      { beforeTokens: 1000, afterTokens: 400 },
    ]
    expect(summarizeCompactions(events)).toEqual({ count: 1, reductionTokens: 600 })
  })

  it("handles an event where after >= before and contributes 0 reduction but still increments count", () => {
    const eventsEqual: CompactionEvent[] = [
      { beforeTokens: 1000, afterTokens: 1000 },
    ]
    expect(summarizeCompactions(eventsEqual)).toEqual({ count: 1, reductionTokens: 0 })

    const eventsWorse: CompactionEvent[] = [
      { beforeTokens: 1000, afterTokens: 1200 },
    ]
    expect(summarizeCompactions(eventsWorse)).toEqual({ count: 1, reductionTokens: 0 })
  })

  it("summarizes multiple events with a mix of valid/invalid reductions correctly", () => {
    const events: CompactionEvent[] = [
      { beforeTokens: 1000, afterTokens: 400 },  // 600 reduction
      { beforeTokens: 500, afterTokens: 500 },    // 0 reduction
      { beforeTokens: 200, afterTokens: 300 },    // 0 reduction (no negative)
      { beforeTokens: 800, afterTokens: 300 },    // 500 reduction
    ]
    expect(summarizeCompactions(events)).toEqual({ count: 4, reductionTokens: 1100 })
  })

  it("handles negative or zero token values gracefully without going negative or throwing", () => {
    const zeroBefore: CompactionEvent[] = [
      { beforeTokens: 0, afterTokens: 100 },
    ]
    expect(summarizeCompactions(zeroBefore)).toEqual({ count: 1, reductionTokens: 0 })

    const negativeValues: CompactionEvent[] = [
      { beforeTokens: -100, afterTokens: -200 }, // -100 - (-200) = 100 reduction
      { beforeTokens: -200, afterTokens: -100 }, // -200 - (-100) = -100 -> clamped to 0
    ]
    expect(summarizeCompactions(negativeValues)).toEqual({ count: 2, reductionTokens: 100 })
  })
})