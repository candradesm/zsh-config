import { describe, expect, it } from "bun:test"
import { summarizeCompactions, resolveCompactionEvents, type CompactionEvent } from "@model-usage/helpers/compaction"

// ─── summarizeCompactions ───────────────────────────────────────────────────

describe("summarizeCompactions", () => {
  it("returns count 0, measured 0, and reductionTokens 0 for an empty array", () => {
    expect(summarizeCompactions([])).toEqual({ count: 0, measured: 0, reductionTokens: 0 })
  })

  it("handles a single event with before > after and computes correct positive reduction", () => {
    const events: CompactionEvent[] = [
      { beforeTokens: 1000, afterTokens: 400 },
    ]
    expect(summarizeCompactions(events)).toEqual({ count: 1, measured: 1, reductionTokens: 600 })
  })

  it("handles an event where after >= before and contributes 0 reduction but still increments count and measured", () => {
    const eventsEqual: CompactionEvent[] = [
      { beforeTokens: 1000, afterTokens: 1000 },
    ]
    expect(summarizeCompactions(eventsEqual)).toEqual({ count: 1, measured: 1, reductionTokens: 0 })

    const eventsWorse: CompactionEvent[] = [
      { beforeTokens: 1000, afterTokens: 1200 },
    ]
    expect(summarizeCompactions(eventsWorse)).toEqual({ count: 1, measured: 1, reductionTokens: 0 })
  })

  it("summarizes multiple events with a mix of valid/invalid reductions correctly", () => {
    const events: CompactionEvent[] = [
      { beforeTokens: 1000, afterTokens: 400 },  // 600 reduction
      { beforeTokens: 500, afterTokens: 500 },    // 0 reduction
      { beforeTokens: 200, afterTokens: 300 },    // 0 reduction (no negative)
      { beforeTokens: 800, afterTokens: 300 },    // 500 reduction
    ]
    expect(summarizeCompactions(events)).toEqual({ count: 4, measured: 4, reductionTokens: 1100 })
  })

  it("handles events with undefined afterTokens (unresolved)", () => {
    const events: CompactionEvent[] = [
      { beforeTokens: 1000, afterTokens: undefined },
      { beforeTokens: 500, afterTokens: 200 },    // 300 reduction, measured
    ]
    expect(summarizeCompactions(events)).toEqual({ count: 2, measured: 1, reductionTokens: 300 })
  })

  it("handles negative or zero token values gracefully without going negative or throwing", () => {
    const zeroBefore: CompactionEvent[] = [
      { beforeTokens: 0, afterTokens: 100 },
    ]
    expect(summarizeCompactions(zeroBefore)).toEqual({ count: 1, measured: 1, reductionTokens: 0 })

    const negativeValues: CompactionEvent[] = [
      { beforeTokens: -100, afterTokens: -200 }, // -100 - (-200) = 100 reduction
      { beforeTokens: -200, afterTokens: -100 }, // -200 - (-100) = -100 -> clamped to 0
    ]
    expect(summarizeCompactions(negativeValues)).toEqual({ count: 2, measured: 2, reductionTokens: 100 })
  })
})

// ─── resolveCompactionEvents ─────────────────────────────────────────────────

describe("resolveCompactionEvents", () => {
  it("resolves after from next assistant rawPrompt after compaction", () => {
    const messages = [
      { id: "msg1", info: { role: "assistant", providerID: "p", modelID: "m", tokens: { input: 1000, output: 200, cache: { read: 49000, write: 0 } } }, parts: [] },
      { id: "msg_comp", info: { role: "user" }, parts: [{ type: "compaction" }, { type: "text", text: "summary..." }] },
      { id: "msg2", info: { role: "assistant", providerID: "p", modelID: "m", tokens: { input: 8000, output: 300, cache: { read: 0, write: 0 } } }, parts: [] },
    ]
    const { events, summary } = resolveCompactionEvents(messages)
    expect(events).toHaveLength(1)
    expect(events[0].beforeTokens).toBe(50000) // 1000 + 49000 + 0
    expect(events[0].afterTokens).toBe(8000)   // 8000 + 0 + 0
    expect(summary.count).toBe(1)
    expect(summary.measured).toBe(1)
    expect(summary.reductionTokens).toBe(42000) // 50000 - 8000
  })

  it("trailing compaction leaves after undefined (counted, not measured)", () => {
    const messages = [
      { id: "msg1", info: { role: "assistant", providerID: "p", modelID: "m", tokens: { input: 1000, output: 200, cache: { read: 49000, write: 0 } } }, parts: [] },
      { id: "msg_comp", info: { role: "user" }, parts: [{ type: "compaction" }, { type: "text", text: "summary..." }] },
    ]
    const { events, summary } = resolveCompactionEvents(messages)
    expect(events).toHaveLength(1)
    expect(events[0].beforeTokens).toBe(50000)
    expect(events[0].afterTokens).toBeUndefined()
    expect(summary.count).toBe(1)
    expect(summary.measured).toBe(0)
    expect(summary.reductionTokens).toBe(0)
  })

  it("leading compaction (no prior assistant) sets before=0", () => {
    const messages = [
      { id: "msg_comp", info: { role: "user" }, parts: [{ type: "compaction" }, { type: "text", text: "summary..." }] },
      { id: "msg1", info: { role: "assistant", providerID: "p", modelID: "m", tokens: { input: 8000, output: 300, cache: { read: 0, write: 0 } } }, parts: [] },
    ]
    const { events, summary } = resolveCompactionEvents(messages)
    expect(events).toHaveLength(1)
    expect(events[0].beforeTokens).toBe(0)
    expect(events[0].afterTokens).toBe(8000)
    expect(summary.count).toBe(1)
    expect(summary.measured).toBe(1)
  })

  it("mixed resolvable and unresolved compaction events", () => {
    const messages = [
      { id: "msg1", info: { role: "assistant", providerID: "p", modelID: "m", tokens: { input: 1000, output: 200, cache: { read: 49000, write: 0 } } }, parts: [] },
      { id: "comp1", info: { role: "user" }, parts: [{ type: "compaction" }, { type: "text", text: "summary..." }] },
      { id: "msg2", info: { role: "assistant", providerID: "p", modelID: "m", tokens: { input: 8000, output: 300, cache: { read: 0, write: 0 } } }, parts: [] },
      { id: "comp2", info: { role: "user" }, parts: [{ type: "compaction" }, { type: "text", text: "summary..." }] },
    ]
    const { events, summary } = resolveCompactionEvents(messages)
    expect(events).toHaveLength(2)
    // compaction1 resolved
    expect(events[0].beforeTokens).toBe(50000)
    expect(events[0].afterTokens).toBe(8000)
    // compaction2 unresolved
    expect(events[1].beforeTokens).toBe(8000)
    expect(events[1].afterTokens).toBeUndefined()
    // Summary
    expect(summary.count).toBe(2)
    expect(summary.measured).toBe(1) // only compaction1 has afterTokens
    expect(summary.reductionTokens).toBe(42000) // only from compaction1
  })

  it("title-gen call skipped for after", () => {
    // assistant(real, 50000) → compaction → assistant(title-gen, 0) → assistant(real, 8000)
    const messages = [
      { id: "msg1", info: { role: "assistant", providerID: "p", modelID: "m", tokens: { input: 1000, output: 200, cache: { read: 49000, write: 0 } } }, parts: [] },
      { id: "comp", info: { role: "user" }, parts: [{ type: "compaction" }, { type: "text", text: "summary..." }] },
      { id: "title_gen", info: { role: "assistant", providerID: "p", modelID: "m-title", tokens: { input: 0, output: 50, cache: { read: 0, write: 0 } } }, parts: [{ type: "text", text: "Title" }] },
      { id: "msg2", info: { role: "assistant", providerID: "p", modelID: "m", tokens: { input: 8000, output: 300, cache: { read: 0, write: 0 } } }, parts: [] },
    ]
    const { events, summary } = resolveCompactionEvents(messages)
    expect(events).toHaveLength(1)
    // after should be from the second real assistant (8000), not the title-gen stub
    expect(events[0].beforeTokens).toBe(50000)
    expect(events[0].afterTokens).toBe(8000)
    expect(summary.count).toBe(1)
    expect(summary.measured).toBe(1)
    expect(summary.reductionTokens).toBe(42000) // 50000 - 8000
  })
})
