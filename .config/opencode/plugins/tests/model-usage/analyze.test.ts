import { describe, expect, it } from "bun:test"
import { estimateTokens, estimateVisibleOutputTokens, rawPromptTokens, scaleEntries } from "@model-usage/helpers/tokens"
import { aggregateModelStats } from "@model-usage/helpers/models"
import type { ModelUsageRecord } from "@model-usage/helpers/models"
import { splitSystemFragments } from "@model-usage/helpers/fragments"
import { loadBaseline } from "@model-usage/db"
import { truncateLabel } from "@model-usage/helpers/format"
import { computeModelsTabLayout } from "@model-usage/helpers/model-tab"

// ─── estimateTokens ───────────────────────────────────────────────────────────

describe("estimateTokens", () => {
  it("returns 0 for empty / whitespace", () => {
    expect(estimateTokens("")).toBe(0)
    expect(estimateTokens("   ")).toBe(1) // 3 chars → ceil(3/4)=1
  })

  it("returns ceil(chars/4)", () => {
    expect(estimateTokens("abcd")).toBe(1)
    expect(estimateTokens("abcde")).toBe(2) // 5 chars → ceil(5/4)=2
    expect(estimateTokens("a".repeat(400))).toBe(100)
  })
})

// ─── rawPromptTokens ──────────────────────────────────────────────────────────

describe("rawPromptTokens", () => {
  it("reconstitutes raw from adjusted input (opencode-go: no caching)", () => {
    // opencode-go: cache.read=0, cache.write=0 → tokens.input is the raw.
    expect(rawPromptTokens({ input: 24984, cache: { read: 0, write: 0 } })).toBe(24984)
  })

  it("reconstitutes raw for Anthropic first call (cache.write = system)", () => {
    // Anthropic first call: raw = system+user=25035, cache.write=system=24984,
    // cache.read=0 → tokens.input (adjusted) = 25035-0-24984 = 51 (user only).
    // Reconstitute: 51 + 0 + 24984 = 25035. ✓
    expect(rawPromptTokens({ input: 51, cache: { read: 0, write: 24984 } })).toBe(25035)
  })

  it("reconstitutes raw for Copilot resumed call (cache.read > 0)", () => {
    // Resumed: raw = 100000, cache.read = 80000, cache.write = 0
    // → tokens.input (adjusted) = 100000-80000-0 = 20000.
    // Reconstitute: 20000 + 80000 + 0 = 100000. ✓
    expect(rawPromptTokens({ input: 20000, cache: { read: 80000, write: 0 } })).toBe(100000)
  })

  it("handles missing / malformed fields as 0", () => {
    expect(rawPromptTokens({})).toBe(0)
    expect(rawPromptTokens({ input: -5, cache: { read: -1, write: -2 } })).toBe(0)
    expect(rawPromptTokens(undefined as any)).toBe(0)
  })
})

// ─── scaleEntries ─────────────────────────────────────────────────────────────

describe("scaleEntries", () => {
  it("scales entries proportionally to the target total", () => {
    const entries = [
      { label: "a", tokens: 100 },
      { label: "b", tokens: 200 },
      { label: "c", tokens: 300 },
    ]
    const out = scaleEntries(entries, 1200) // measured sum=600, factor=2
    expect(out.reduce((s, e) => s + e.tokens, 0)).toBe(1200)
    expect(out[0].tokens).toBe(200)
    expect(out[1].tokens).toBe(400)
    expect(out[2].tokens).toBe(600)
  })

  it("pushes the rounding remainder onto the first entry", () => {
    const entries = [{ label: "a", tokens: 1 }, { label: "b", tokens: 1 }, { label: "c", tokens: 1 }]
    const out = scaleEntries(entries, 100) // 3 entries, target 100
    const sum = out.reduce((s, e) => s + e.tokens, 0)
    expect(sum).toBe(100)
  })

  it("returns all-zero when target <= 0", () => {
    const entries = [{ label: "a", tokens: 100 }]
    const out = scaleEntries(entries, 0)
    expect(out[0].tokens).toBe(0)
  })

  it("splits evenly when measured sum is 0 but target > 0", () => {
    const entries = [{ label: "a", tokens: 0 }, { label: "b", tokens: 0 }]
    const out = scaleEntries(entries, 100)
    expect(out.reduce((s, e) => s + e.tokens, 0)).toBe(100)
  })

  it("returns empty for empty input", () => {
    expect(scaleEntries([], 100)).toEqual([])
  })

  it("does not mutate the input array", () => {
    const entries = [{ label: "a", tokens: 100 }]
    scaleEntries(entries, 200)
    expect(entries[0].tokens).toBe(100) // unchanged
  })
})

// ─── splitSystemFragments ─────────────────────────────────────────────────────

describe("splitSystemFragments", () => {
  it("returns empty for empty input", () => {
    expect(splitSystemFragments("")).toEqual([])
    expect(splitSystemFragments("   ")).toEqual([])
  })

  it("does not split on markdown headers and merges them into a single fragment", () => {
    const text = `Instructions from: /some/path/AGENTS.md
### Organization & Checklist
Some checklist text.
### Basic Universal Rules
Some basic rules.
### Common Pitfalls to Avoid
Some pitfalls.`
    const frags = splitSystemFragments(text)
    expect(frags.length).toBe(1)
    expect(frags[0].label).toBe("/some/path/AGENTS.md")
  })

  it("splits on XML section markers correctly", () => {
    const text = `<available_references>
Some references here.
</available_references>
<mcp_instructions>
Some instructions.
</mcp_instructions>`
    const frags = splitSystemFragments(text)
    expect(frags.length).toBe(2)
    expect(frags.some((f) => f.label === "References")).toBe(true)
    expect(frags.some((f) => f.label === "MCP Instructions")).toBe(true)
  })

  it("splits on non-jungle-mode 'Instructions from:' markers correctly", () => {
    const text = `Instructions from: /path/to/one.md
content one
Instructions from: /path/to/two.md
content two`
    const frags = splitSystemFragments(text)
    expect(frags.length).toBe(2)
    expect(frags.some((f) => f.label === "/path/to/one.md")).toBe(true)
    expect(frags.some((f) => f.label === "/path/to/two.md")).toBe(true)
  })

  it("terminates jungle-mode blocks at 2 consecutive blank lines and does not swallow subsequent content", () => {
    const text = `Instructions from: jungle-mode/persona
🍌 JUNGLE MODE ACTIVE 🍌
You are Warrior Monke!


Some unrelated content after the jungle-mode block ends.`
    const frags = splitSystemFragments(text)
    expect(frags.length).toBe(2)
    expect(frags.some((f) => f.label === "jungle-mode/persona")).toBe(true)
    expect(frags.some((f) => f.label === "Agent System Prompt")).toBe(true)
  })

  it("labels marker-less content at the very start as 'Agent System Prompt'", () => {
    const text = `Some starting instructions without markers.
## Header 1
More info.
# Header 2
End of system prompt.

Instructions from: /some/path.md
Content here.`
    const frags = splitSystemFragments(text)
    expect(frags.length).toBe(2)
    expect(frags[0].label).toBe("Agent System Prompt")
    expect(frags[1].label).toBe("/some/path.md")
  })

  it("labels marker-less content immediately following a terminated jungle-mode block as 'Agent System Prompt'", () => {
    const text = `Instructions from: jungle-mode/persona
🍌 JUNGLE MODE ACTIVE 🍌
You are Warrior Monke!


Unmarked text that continues after the jungle mode.`
    const frags = splitSystemFragments(text)
    const promptFrag = frags.find((f) => f.label === "Agent System Prompt")
    expect(promptFrag).toBeDefined()
    expect(promptFrag!.tokens).toBeGreaterThan(0)
  })

  it("merges other stray marker-less content gaps into a single 'Other' fragment with combined token count", () => {
    const text = `<available_references>
Ref contents
</available_references>
Stray content group one
<mcp_instructions>
MCP contents
</mcp_instructions>
Stray content group two
<available_skills>
Skill contents
</available_skills>`
    const frags = splitSystemFragments(text)
    const otherFrag = frags.find((f) => f.label === "Other")
    expect(otherFrag).toBeDefined()
    expect(otherFrag!.tokens).toBe(12)
    expect(frags.filter((f) => f.label === "Other").length).toBe(1)
  })

  it("has no 'Agent System Prompt' or 'Other' when document has zero marker-less content", () => {
    const text = `<available_references>
Ref contents
</available_references>
<available_skills>
Skill contents
</available_skills>`
    const frags = splitSystemFragments(text)
    expect(frags.some((f) => f.label === "Agent System Prompt")).toBe(false)
    expect(frags.some((f) => f.label === "Other")).toBe(false)
  })

  it("caps to top-N + other", () => {
    let text = ""
    for (let i = 0; i < 15; i++) {
      text += `Instructions from: /path/${i}.md\n${"x".repeat((i + 1) * 100)}\n`
    }
    const frags = splitSystemFragments(text, 10)
    expect(frags.length).toBe(11)
    expect(frags[frags.length - 1].label).toBe("… more")
  })

  it("sorts by tokens descending", () => {
    const text = `Instructions from: /path/small.md
ab
Instructions from: /path/big.md
` + "x".repeat(1000)
    const frags = splitSystemFragments(text)
    expect(frags.length).toBe(2)
    expect(frags[0].label).toBe("/path/big.md")
    expect(frags[0].tokens).toBeGreaterThan(frags[1].tokens)
  })
})

// ─── loadBaseline ─────────────────────────────────────────────────────────────
// Tier 1 reader. Uses a temp DB so the test is hermetic.

describe("loadBaseline", () => {
  it("returns null when the table does not exist", () => {
    // /tmp path with no DB — bun:sqlite will create an empty DB (no tables).
    const tmp = `/tmp/opencode-test-${Date.now()}.db`
    try {
      expect(loadBaseline(tmp, "ses_xxx")).toBeNull()
    } finally {
      try { require("node:fs").unlinkSync(tmp) } catch { /* ignore */ }
    }
  })

  it("returns null when the session has no row", () => {
    const tmp = `/tmp/opencode-test-${Date.now()}.db`
    try {
      const { Database } = require("bun:sqlite")
      const db = new Database(tmp)
      db.run("CREATE TABLE session_context_epoch (session_id TEXT PRIMARY KEY, baseline TEXT NOT NULL, snapshot TEXT NOT NULL, baseline_seq INTEGER NOT NULL)")
      db.close()
      expect(loadBaseline(tmp, "ses_missing")).toBeNull()
    } finally {
      try { require("node:fs").unlinkSync(tmp) } catch { /* ignore */ }
    }
  })

  it("returns the baseline text when a row exists", () => {
    const tmp = `/tmp/opencode-test-${Date.now()}.db`
    try {
      const { Database } = require("bun:sqlite")
      const db = new Database(tmp)
      db.run("CREATE TABLE session_context_epoch (session_id TEXT PRIMARY KEY, baseline TEXT NOT NULL, snapshot TEXT NOT NULL, baseline_seq INTEGER NOT NULL)")
      db.run("INSERT INTO session_context_epoch (session_id, baseline, snapshot, baseline_seq) VALUES (?, ?, '{}', 0)", "ses_real", "hello world baseline")
      db.close()
      expect(loadBaseline(tmp, "ses_real")).toBe("hello world baseline")
    } finally {
      try { require("node:fs").unlinkSync(tmp) } catch { /* ignore */ }
    }
  })
})

// ─── truncateLabel ─────────────────────────────────────────────────────────────

describe("truncateLabel", () => {
  it("pads short labels to maxLen", () => {
    expect(truncateLabel("hi", 26)).toBe("hi" + " ".repeat(24))
  })

  it("returns exact-length label unchanged (no truncation)", () => {
    const label = "a".repeat(26)
    expect(truncateLabel(label, 26)).toBe(label)
  })

  it("truncates overflow labels with ellipsis", () => {
    const label = "very_long_tool_name_that_overflows"
    expect(label.length).toBeGreaterThan(26)
    const result = truncateLabel(label, 26)
    expect(result).toBe("very_long_tool_name_that_…")
    expect(result.length).toBe(26)
  })

  it("uses default maxLen of 26", () => {
    const result = truncateLabel("very_long_tool_name_that_overflows")
    expect(result).toBe("very_long_tool_name_that_…")
    expect(result.length).toBe(26)
  })

  it("handles empty string", () => {
    expect(truncateLabel("", 26)).toBe(" ".repeat(26))
  })
})

// ─── Models Tab Token Share Regression Test ───────────────────────────────────

describe("Models Tab Token Share Regression Test", () => {
  it("verifies that modelB (cold-cache spike) legitimately outranks modelA (workhorse) on % tokens under the new input+output (/usage-mirror) scheme", () => {
    // DESIGN NOTE (deliberate trade-off): using input+output for % means a
    // cold-cache-switch model can legitimately outrank a workhorse model on
    // token usage (those tokens WERE billed). The `msgCount` counterbalances
    // this. Under the old (visibleOutput) scheme, modelA outranked modelB on
    // share because visibleOutput favored modelA's long prose. The new scheme
    // correctly reflects that modelB's cold-cache spike cost real money.

    // 1. Simulate modelA (workhorse): 10 turns, small input deltas, growing cache, large visible text, moderate output payload.
    const modelARecords: ModelUsageRecord[] = []
    for (let i = 0; i < 10; i++) {
      const parts = [
        { type: "text", text: "This is substantial visible assistant prose written by modelA to prove it carried the session. ".repeat(10) }
      ]
      modelARecords.push({
        providerID: "anthropic",
        modelID: "claude-3-5-sonnet",
        inputTokens: 1000,
        outputTokens: 500,
        cacheRead: 5000 + i * 1000,
        cacheWrite: 0,
        cost: 0.005,
        visibleOutputTokens: estimateVisibleOutputTokens(parts),
      })
    }

    // 2. Simulate modelB (cold-cache switch): 2 turns, massive input spike (cache invalidation), short visible text, huge output (tool JSON).
    const modelBRecords: ModelUsageRecord[] = []
    for (let i = 0; i < 2; i++) {
      const parts = [
        { type: "text", text: "Sure, let's proceed." },
        { type: "tool-call", text: '{"some_massive_json_payload": "..."}' },
      ]
      modelBRecords.push({
        providerID: "openai",
        modelID: "gpt-4o",
        inputTokens: 75000,
        outputTokens: 5000,
        cacheRead: 0,
        cacheWrite: 0,
        cost: 0.15,
        visibleOutputTokens: estimateVisibleOutputTokens(parts),
      })
    }

    const allRecords = [...modelARecords, ...modelBRecords]
    const stats = aggregateModelStats(allRecords)
    const modelAStat = stats.find(s => s.modelID === "claude-3-5-sonnet")!
    const modelBStat = stats.find(s => s.modelID === "gpt-4o")!

    expect(modelAStat).toBeDefined()
    expect(modelBStat).toBeDefined()

    // Use the production layout function to get sorted stats and total
    const { sortedStats, totalModelTokens } = computeModelsTabLayout(stats)

    // Total model tokens (input+output across all models)
    // modelA: inputTokens=10000, outputTokens=5000  → 15000
    // modelB: inputTokens=150000, outputTokens=10000 → 160000
    // total = 175000
    expect(totalModelTokens).toBe(175000)

    // Assert that modelB legitimately outranks modelA on % tokens
    // (cold-cache tax IS real billed usage — this is intentional)
    const modelATokens = modelAStat.inputTokens + modelAStat.outputTokens // 15000
    const modelBTokens = modelBStat.inputTokens + modelBStat.outputTokens // 160000
    const modelAPct = (modelATokens / totalModelTokens) * 100
    const modelBPct = (modelBTokens / totalModelTokens) * 100

    expect(modelBPct).toBeGreaterThan(modelAPct)
    expect(modelBPct).toBeCloseTo(91.4, 1)
    expect(modelAPct).toBeCloseTo(8.6, 1)

    // Sort order: modelB (160000 tokens) first, modelA (15000) second
    expect(sortedStats[0].modelID).toBe("gpt-4o")
    expect(sortedStats[1].modelID).toBe("claude-3-5-sonnet")

    // msgCount counterbalances: modelA has 10 msgs vs modelB's 2
    expect(modelAStat.msgCount).toBe(10)
    expect(modelBStat.msgCount).toBe(2)

    // visibleOutputTokens and outputTokens remain correct for ↓ display
    expect(modelAStat.visibleOutputTokens).toBe(2380)
    expect(modelBStat.visibleOutputTokens).toBe(10)
    expect(modelAStat.outputTokens).toBe(5000)
    expect(modelBStat.outputTokens).toBe(10000)
  })
})

// ─── Models Tab Input Tokens Last-Value-Wins Regression Test ──────────────────

describe("Models Tab Input Tokens Last-Value-Wins Regression Test", () => {
  it("verifies that input token display (↑) uses lastCallRawPromptTokens (last-call reconstructed raw prompt) per the /usage-mirror scheme, preventing cold-cache spike from dwarfing the workhorse model", () => {
    // Under the /usage-mirror scheme, the ↑ display shows lastCallRawPromptTokens
    // (reconstructed raw prompt of the chronologically last call for each model).
    // This avoids double-counting the same accumulated context on every turn and
    // reflects the true scale of the conversation's active state. By contrast,
    // summing tokens.input across all turns would unfairly dwarf the warm-cache
    // workhorse (whose per-turn input deltas are small) vs the cold-cache switch
    // model (whose first-turn input includes the full context).

    // 1. Simulate modelA (workhorse): 10 turns, growing warm cache, small input deltas.
    const modelARecords: ModelUsageRecord[] = []
    for (let i = 0; i < 10; i++) {
      const inputTokens = 1000 + i * 100 // 1000 to 1900
      const cacheRead = 20000 + i * 6000 // 20000 to 74000
      const cacheWrite = 0
      
      const currentRawPrompt = rawPromptTokens({
        input: inputTokens,
        cache: { read: cacheRead, write: cacheWrite }
      })

      modelARecords.push({
        providerID: "anthropic",
        modelID: "claude-3-5-sonnet",
        inputTokens,
        outputTokens: 200,
        cacheRead,
        cacheWrite,
        cost: 0.001,
        visibleOutputTokens: 150,
        lastCallRawPromptTokens: currentRawPrompt,
      })
    }

    // 2. Simulate modelB (minority switched-in model): 2 turns.
    // First turn: massive input spike from cold cache switch.
    // Second turn: some cache read recovery, smaller input.
    const modelBRecords: ModelUsageRecord[] = [
      {
        providerID: "openai",
        modelID: "gpt-4o",
        inputTokens: 75000,
        outputTokens: 300,
        cacheRead: 0,
        cacheWrite: 0,
        cost: 0.005,
        visibleOutputTokens: 20,
        lastCallRawPromptTokens: rawPromptTokens({
          input: 75000,
          cache: { read: 0, write: 0 }
        })
      },
      {
        providerID: "openai",
        modelID: "gpt-4o",
        inputTokens: 15000,
        outputTokens: 400,
        cacheRead: 60000,
        cacheWrite: 0,
        cost: 0.003,
        visibleOutputTokens: 30,
        lastCallRawPromptTokens: rawPromptTokens({
          input: 15000,
          cache: { read: 60000, write: 0 }
        })
      }
    ]

    const allRecords = [...modelARecords, ...modelBRecords]
    const stats = aggregateModelStats(allRecords)
    const modelAStat = stats.find(s => s.modelID === "claude-3-5-sonnet")!
    const modelBStat = stats.find(s => s.modelID === "gpt-4o")!

    expect(modelAStat).toBeDefined()
    expect(modelBStat).toBeDefined()

    // The lastCallRawPromptTokens field is still present and works correctly (not dropped)
    // modelA last call: input=1900, cacheRead=74000 → lastCallRawPromptTokens = 75900
    // modelB last call: input=15000, cacheRead=60000 → lastCallRawPromptTokens = 75000
    const inputDisplayA = modelAStat.lastCallRawPromptTokens
    const inputDisplayB = modelBStat.lastCallRawPromptTokens

    // modelA's display reflects its own last call's reconstructed raw prompt size
    // (sizable, reflecting the full conversation scale)
    expect(inputDisplayA).toBe(75900)

    // modelB's display reflects only ITS last call's reconstructed size,
    // NOT the inflated first-call spike, and NOT a sum of both calls
    expect(inputDisplayB).toBe(75000)
    expect(inputDisplayB).not.toBe(150000) // not sum of both calls' reconstructed prompt tokens
    expect(inputDisplayB).not.toBe(90000) // not sum of input tokens
    expect(inputDisplayB).not.toBe(75000 + 75000) // not summed reconstructed prompt tokens

    // The input display comparison correctly reflects relative context weight:
    // modelA's warm-cache last call (75900) exceeds modelB's second call (75000)
    expect(inputDisplayA).toBeGreaterThan(inputDisplayB!)
  })
})

// ─── Models Tab Degenerate Last Call Regression Test ───────────────────

describe("Models Tab Degenerate Last Call Regression Test", () => {
  it("reproduces the real-world scenario of a compaction-adjacent stub/aborted call with all-zero telemetry and verifies it doesn't clobber the first model's raw prompt tokens, while tracking a second model with ongoing usage", () => {
    // We simulate the exact processing loop found in analyze.tsx (~lines 298-335)
    
    // Define our simulated message stream
    const sessionMessages: any[] = [
      // Turn 1: Gemini-3.5-Flash has real call
      {
        id: "msg_gemini_1",
        info: {
          role: "assistant",
          providerID: "google",
          modelID: "gemini-3.5-flash",
          tokens: {
            input: 10000,
            output: 200,
            cache: { read: 5000, write: 0 },
          },
          cost: 0.001,
        },
        parts: [{ type: "text", text: "Gemini response one." }],
      },
      // Turn 2: Gemini-3.5-Flash has second real call
      {
        id: "msg_gemini_2",
        info: {
          role: "assistant",
          providerID: "google",
          modelID: "gemini-3.5-flash",
          tokens: {
            input: 12000,
            output: 300,
            cache: { read: 8000, write: 0 },
          },
          cost: 0.0015,
        },
        parts: [{ type: "text", text: "Gemini response two." }],
      },
      // Turn 3: A compaction-adjacent stub/aborted call with all-zero telemetry as Gemini's chronologically LAST occurrence.
      // This has tokens.input=0, tokens.output=0, cache.read=0, cache.write=0, cost=0.
      {
        id: "msg_gemini_stub",
        info: {
          role: "assistant",
          providerID: "google",
          modelID: "gemini-3.5-flash",
          tokens: {
            input: 0,
            output: 0,
            cache: { read: 0, write: 0 },
          },
          cost: 0,
        },
        parts: [], // no real telemetry or visible text
      },
      // Turn 4: A second model ("claude-sonnet-5") with real ongoing usage after the compaction
      {
        id: "msg_claude_1",
        info: {
          role: "assistant",
          providerID: "anthropic",
          modelID: "claude-sonnet-5",
          tokens: {
            input: 15000,
            output: 500,
            cache: { read: 12000, write: 0 },
          },
          cost: 0.004,
        },
        parts: [{ type: "text", text: "Claude response one." }],
      }
    ]

    // Simulate analyze.tsx parser building modelUsageRecords
    const modelUsageRecords: any[] = []

    for (const msg of sessionMessages) {
      const info = msg.info
      if (info.role !== "assistant" && info.role !== "user") continue
      const parts: any[] = msg.parts ?? []

      if (info.role === "assistant") {
        const asstInfo = info
        const providerID = asstInfo.providerID
        const modelID = asstInfo.modelID
        if (providerID && modelID) {
          const currentRawPrompt = rawPromptTokens({
            input: asstInfo.tokens?.input ?? 0,
            cache: {
              read: asstInfo.tokens?.cache?.read ?? 0,
              write: asstInfo.tokens?.cache?.write ?? 0,
            },
          })

          const hasTelemetry = currentRawPrompt > 0 || (asstInfo.tokens?.output ?? 0) > 0 || (asstInfo.tokens?.reasoning ?? 0) > 0 || (asstInfo.cost ?? 0) > 0

          if (hasTelemetry) {
            modelUsageRecords.push({
              providerID,
              modelID,
              inputTokens: asstInfo.tokens?.input ?? 0,
              outputTokens: asstInfo.tokens?.output ?? 0,
              cacheRead: asstInfo.tokens?.cache?.read ?? 0,
              cacheWrite: asstInfo.tokens?.cache?.write ?? 0,
              cost: asstInfo.cost ?? 0,
              visibleOutputTokens: estimateVisibleOutputTokens(parts),
              lastCallRawPromptTokens: currentRawPrompt,
            })
          }
        }
      }
    }

    // Now aggregate using aggregateModelStats()
    const stats = aggregateModelStats(modelUsageRecords)

    // We should have stats for both models
    const geminiStat = stats.find(s => s.modelID === "gemini-3.5-flash")!
    const claudeStat = stats.find(s => s.modelID === "claude-sonnet-5")!

    expect(geminiStat).toBeDefined()
    expect(claudeStat).toBeDefined()

    // Assert that the first model's (Gemini) ↑ figure (lastCallRawPromptTokens) reflects its real prior usage (NOT zero)
    // Real prior last call was msg_gemini_2: input=12000, cacheRead=8000 -> raw = 20000.
    expect(geminiStat.lastCallRawPromptTokens).toBe(20000)

    // Assert that its msgCount is 2 (the stub call is excluded completely because hasTelemetry is false)
    expect(geminiStat.msgCount).toBe(2)

    // Assert that its cacheRead and cost remain correct (not broken, but let's verify)
    // input = 10000 + 12000 = 22000
    // cacheRead = 5000 + 8000 = 13000
    // cost = 0.001 + 0.0015 = 0.0025
    expect(geminiStat.inputTokens).toBe(22000)
    expect(geminiStat.cacheRead).toBe(13000)
    expect(geminiStat.cost).toBe(0.0025)

    // Assert that the second model (Claude) has the correct stats
    // Claude last call: input=15000, cacheRead=12000 -> raw = 27000
    expect(claudeStat.lastCallRawPromptTokens).toBe(27000)
    expect(claudeStat.msgCount).toBe(1)
    expect(claudeStat.inputTokens).toBe(15000)
    expect(claudeStat.cacheRead).toBe(12000)
    expect(claudeStat.cost).toBe(0.004)
  })

  it("retains a record with reasoning tokens > 0 even if input=0, output=0, and cost=0", () => {
    const sessionMessages: any[] = [
      {
        id: "msg_reasoning_only",
        info: {
          role: "assistant",
          providerID: "openai",
          modelID: "o1-mini",
          tokens: {
            input: 0,
            output: 0,
            reasoning: 450,
            cache: { read: 0, write: 0 },
          },
          cost: 0,
        },
        parts: [],
      }
    ]

    const modelUsageRecords: any[] = []

    for (const msg of sessionMessages) {
      const info = msg.info
      if (info.role !== "assistant" && info.role !== "user") continue
      const parts: any[] = msg.parts ?? []

      if (info.role === "assistant") {
        const asstInfo = info
        const providerID = asstInfo.providerID
        const modelID = asstInfo.modelID
        if (providerID && modelID) {
          const currentRawPrompt = rawPromptTokens({
            input: asstInfo.tokens?.input ?? 0,
            cache: {
              read: asstInfo.tokens?.cache?.read ?? 0,
              write: asstInfo.tokens?.cache?.write ?? 0,
            },
          })

          const hasTelemetry = currentRawPrompt > 0 || (asstInfo.tokens?.output ?? 0) > 0 || (asstInfo.tokens?.reasoning ?? 0) > 0 || (asstInfo.cost ?? 0) > 0

          if (hasTelemetry) {
            modelUsageRecords.push({
              providerID,
              modelID,
              inputTokens: asstInfo.tokens?.input ?? 0,
              outputTokens: asstInfo.tokens?.output ?? 0,
              cacheRead: asstInfo.tokens?.cache?.read ?? 0,
              cacheWrite: asstInfo.tokens?.cache?.write ?? 0,
              cost: asstInfo.cost ?? 0,
              visibleOutputTokens: estimateVisibleOutputTokens(parts),
              lastCallRawPromptTokens: currentRawPrompt,
            })
          }
        }
      }
    }

    const stats = aggregateModelStats(modelUsageRecords)
    expect(stats.length).toBe(1)
    expect(stats[0].modelID).toBe("o1-mini")
    expect(stats[0].msgCount).toBe(1)

    // Reasoning-only models (input=0, output=0, reasoning>0) show pct=0
    // mirroring /usage which also excludes reasoning from its SQL. Accepted edge case.
    const { totalModelTokens } = computeModelsTabLayout(stats)
    expect(totalModelTokens).toBe(0) // input+output = 0 for reasoning-only
  })
})

// ─── 0% Bug Regression — Tool-Only Model ──────────────────────────────────

describe("0% Bug Regression — Tool-Only Model", () => {
  it("verifies a tool-only model (no visible prose) gets pct > 0 under the new input+output scheme", () => {
    // CRITICAL REGRESSION TEST: Under the old visibleOutput-based scheme, a model
    // that only produces tool-call parts (no text parts) would show pct = 0 because
    // visibleOutputTokens = 0. Under the new input+output (/usage-mirror) scheme,
    // the model correctly gets pct > 0 because inputTokens + outputTokens > 0.

    // Simulate modelC with only tool-call parts — no text parts at all.
    const modelCRecords: ModelUsageRecord[] = [
      {
        providerID: "anthropic",
        modelID: "claude-opus-4",
        inputTokens: 5000,
        outputTokens: 2000,
        cacheRead: 0,
        cacheWrite: 0,
        cost: 0.05,
        visibleOutputTokens: 0, // no text parts → 0 visible output tokens
      },
      {
        providerID: "anthropic",
        modelID: "claude-opus-4",
        inputTokens: 3000,
        outputTokens: 1500,
        cacheRead: 1000,
        cacheWrite: 0,
        cost: 0.03,
        visibleOutputTokens: 0, // tool-call only, still no visible prose
      },
    ]

    const stats = aggregateModelStats(modelCRecords)
    expect(stats.length).toBe(1)
    expect(stats[0].visibleOutputTokens).toBe(0) // no visible prose

    // Under the new scheme: pct is based on input+output
    const { sortedStats, totalModelTokens } = computeModelsTabLayout(stats)

    // totalModelTokens = (5000+3000) + (2000+1500) = 11500
    expect(totalModelTokens).toBe(11500)

    const modelTokens = stats[0].inputTokens + stats[0].outputTokens
    const pct = totalModelTokens > 0 ? (modelTokens / totalModelTokens) * 100 : 0

    // THE KEY ASSERTION: pct > 0, NOT 0!
    expect(pct).toBeGreaterThan(0)
    expect(pct).toBe(100) // only one model, so 100%
    expect(sortedStats[0].modelID).toBe("claude-opus-4")
    expect(sortedStats.length).toBe(1)
  })
})
