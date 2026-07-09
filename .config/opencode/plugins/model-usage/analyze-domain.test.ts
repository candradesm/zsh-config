import { describe, it, expect } from "bun:test"
import { analyzeSessionMessages } from "./analyze-domain"
import type { SystemSnapshot } from "./types"

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeUserMessage(text: string, extras?: { syntheticText?: string }): {
  info: { role: "user"; tokens?: undefined };
  parts: Array<{ type: string; text?: string; synthetic?: boolean }>;
} {
  const parts: Array<{ type: string; text?: string; synthetic?: boolean }> = [
    { type: "text", text },
  ]
  if (extras?.syntheticText) {
    parts.push({ type: "text", text: extras.syntheticText, synthetic: true })
  }
  return { info: { role: "user" }, parts }
}

function makeAssistantMessage(
  tokens: { input?: number; output?: number; cache?: { read?: number; write?: number }; reasoning?: number },
  text: string,
): {
  info: {
    role: "assistant";
    providerID: string;
    modelID: string;
    tokens: typeof tokens;
    cost?: number;
  };
  parts: Array<{ type: string; text: string }>;
} {
  return {
    info: {
      role: "assistant",
      providerID: "test-provider",
      modelID: "test-model",
      tokens,
    },
    parts: [{ type: "text", text }],
  }
}

/** Estimate tokens = ceil(text.length / 4), matching the helpers/tokens.ts implementation. */
function estimateTokens(text: string): number {
  return text.length === 0 ? 0 : Math.ceil(text.length / 4)
}

// ─── Suite: analyzeSessionMessages ───────────────────────────────────────────

describe("analyzeSessionMessages", () => {
  // ─── 1. Cross-validated tier resolution (server + telemetry) ─────────────
  it("uses server snapshot when both server and telemetry are available, with residual TOOL DEFS", () => {
    const userMsg = makeUserMessage("Hello, how are you?")
    const assistantMsg = makeAssistantMessage(
      { input: 24000, cache: { read: 64, write: 0 } },
      "I'm fine, thank you!",
    )

    const serverSnapshot: SystemSnapshot = {
      t: 5536,
      ts: Date.now(),
      fragments: [
        { label: "Agent", tokens: 2200 },
        { label: "Skills", tokens: 1000 },
      ],
    }

    const result = analyzeSessionMessages(
      [userMsg, assistantMsg],
      "test-session-1",
      serverSnapshot,
      null,
    )

    // Find SYSTEM category
    const sysCat = result.categories.find((c) => c.name.startsWith("SYSTEM"))
    expect(sysCat).toBeDefined()
    expect(sysCat!.name).toContain("server")
    expect(sysCat!.name).toContain("⚠")
    expect(sysCat!.totalTokens).toBe(5536)
    expect(sysCat!.entries.length).toBeGreaterThanOrEqual(2)

    // Validate scaled entries sum matches systemTokens
    const sysEntrySum = sysCat!.entries.reduce((s, e) => s + e.tokens, 0)
    expect(sysEntrySum).toBe(5536)

    // Find TOOL DEFS category
    const toolDefsCat = result.categories.find((c) => c.name === "TOOL DEFS")
    expect(toolDefsCat).toBeDefined()
    expect(toolDefsCat!.totalTokens).toBeGreaterThan(0)

    // Verify toolDefsTokens on the result
    expect(result.toolDefsTokens).toBeGreaterThan(0)

    // Verify systemSource via the category name
    expect(sysCat!.name).toMatch(/server/)
  })

  // ─── 2. Telemetry only (no server snapshot) ──────────────────────────────
  it("falls back to telemetry estimate when server snapshot is null", () => {
    const userMsg = makeUserMessage("Hello, how are you?")
    const assistantMsg = makeAssistantMessage(
      { input: 24000 },
      "I'm fine, thank you!",
    )

    const result = analyzeSessionMessages(
      [userMsg, assistantMsg],
      "test-session-2",
      null, // no server snapshot
      null,
    )

    // Find SYSTEM category — should use telemetry estimate
    const sysCat = result.categories.find((c) => c.name.startsWith("SYSTEM"))
    expect(sysCat).toBeDefined()
    expect(sysCat!.name).toContain("telemetry (est.)")
    expect(sysCat!.name).not.toContain("⚠")

    // System source should be telemetry
    const userTokens = estimateTokens("Hello, how are you?")
    const raw = 24000
    const expectedSystemTokens = Math.max(0, raw - userTokens)
    expect(sysCat!.totalTokens).toBe(expectedSystemTokens)

    // No TOOL DEFS category (can't compute without server)
    const toolDefsCat = result.categories.find((c) => c.name === "TOOL DEFS")
    expect(toolDefsCat).toBeUndefined()
    expect(result.toolDefsTokens).toBe(0)

    // System should have a single entry (no server fragments)
    expect(sysCat!.entries.length).toBe(1)
    expect(sysCat!.entries[0].label).toBe("System prompt")
  })

  // ─── 3. Server only (no telemetry) ──────────────────────────────────────
  it("uses server snapshot when telemetry is unavailable", () => {
    const userMsg = makeUserMessage("Hello, how are you?")
    // Assistant with input: 0 — no telemetry, no firstNonzeroAssistant
    const assistantMsg = makeAssistantMessage(
      { input: 0, output: 50 },
      "I'm fine, thank you!",
    )

    const serverSnapshot: SystemSnapshot = {
      t: 5536,
      ts: Date.now(),
      fragments: [
        { label: "Agent", tokens: 2200 },
        { label: "Skills", tokens: 1000 },
      ],
    }

    const result = analyzeSessionMessages(
      [userMsg, assistantMsg],
      "test-session-3",
      serverSnapshot,
      null,
    )

    // Find SYSTEM category
    const sysCat = result.categories.find((c) => c.name.startsWith("SYSTEM"))
    expect(sysCat).toBeDefined()
    expect(sysCat!.name).toContain("server")
    expect(sysCat!.totalTokens).toBe(5536)

    // No TOOL DEFS (no telemetry → no tier2 computed)
    const toolDefsCat = result.categories.find((c) => c.name === "TOOL DEFS")
    expect(toolDefsCat).toBeUndefined()
    expect(result.toolDefsTokens).toBe(0)

    // System entries use server fragments (scaled)
    expect(sysCat!.entries.length).toBeGreaterThanOrEqual(2)
  })

  // ─── 4. No data available ───────────────────────────────────────────────
  it("returns zero system tokens when neither server nor telemetry is available", () => {
    const userMsg = makeUserMessage("Hello, how are you?")
    const assistantMsg = makeAssistantMessage(
      { input: 0 },
      "I'm fine, thank you!",
    )

    const result = analyzeSessionMessages(
      [userMsg, assistantMsg],
      "test-session-4",
      null,  // no server
      null,  // no baseline
    )

    // No SYSTEM category should exist
    const sysCat = result.categories.find((c) => c.name.startsWith("SYSTEM"))
    expect(sysCat).toBeUndefined()

    // toolDefsTokens should be 0
    expect(result.toolDefsTokens).toBe(0)

    // Total categories should only have USER (and ASSISTANT if visible output > 0)
    const userCat = result.categories.find((c) => c.name === "USER")
    expect(userCat).toBeDefined()
  })

  it("returns empty categories for empty messages", () => {
    const result = analyzeSessionMessages(
      [],
      "test-session-empty",
      null,
      null,
    )

    expect(result.categories).toEqual([])
    expect(result.estimatedTotal).toBe(0)
    expect(result.messageCount).toBe(0)
    expect(result.toolDefsTokens).toBe(0)
    expect(result.syntheticTokens).toBe(0)
  })

  // ─── 5. Synthetic text counting ──────────────────────────────────────────
  it("separates synthetic text into SYNTHETICS category", () => {
    const syntheticText = "Called the Read tool to read src/main.ts"
    const userText = "What's in the codebase?"
    const userMsg = makeUserMessage(userText, { syntheticText })
    const assistantMsg = makeAssistantMessage(
      { input: 50 },
      "The codebase contains the main application logic.",
    )

    const result = analyzeSessionMessages(
      [userMsg, assistantMsg],
      "test-session-5",
      null,
      null,
    )

    // SYNTHETICS category should exist
    const synCat = result.categories.find((c) => c.name === "SYNTHETICS")
    expect(synCat).toBeDefined()
    const expectedSynTokens = estimateTokens(syntheticText)
    expect(synCat!.totalTokens).toBeGreaterThan(0)

    // USER category should NOT include synthetic text tokens
    const userCat = result.categories.find((c) => c.name === "USER")
    expect(userCat).toBeDefined()
    const expectedUserTokens = estimateTokens(userText)
    expect(userCat!.totalTokens).toBe(expectedUserTokens)

    // Verify syntheticTokens on result
    expect(result.syntheticTokens).toBeGreaterThan(0)
  })

  it("skips user message entirely when ALL text parts are synthetic", () => {
    const userMsg = {
      info: { role: "user" as const },
      parts: [
        { type: "text", text: "Called the Grep tool to search...", synthetic: true },
      ],
    }
    const assistantMsg = makeAssistantMessage(
      { input: 50 },
      "Here are the results.",
    )

    const result = analyzeSessionMessages(
      [userMsg, assistantMsg],
      "test-session-all-synth",
      null,
      null,
    )

    // No USER category (the message was fully synthetic and skipped)
    const userCat = result.categories.find((c) => c.name === "USER")
    expect(userCat).toBeUndefined()

    // No SYNTHETICS category either — the entire message is skipped,
    // including synthetic counting, when ALL text parts are synthetic.
    const synCat = result.categories.find((c) => c.name === "SYNTHETICS")
    expect(synCat).toBeUndefined()
  })

  // ─── 6. Visor gate fix (server source + 2+ fragments → 2+ entries) ─────
  it("produces 2+ system entries when server source has 2+ fragments", () => {
    const userMsg = makeUserMessage("Hello, how are you?")
    const assistantMsg = makeAssistantMessage(
      { input: 24000, cache: { read: 64, write: 0 } },
      "I'm fine, thank you!",
    )

    const serverSnapshot: SystemSnapshot = {
      t: 5536,
      ts: Date.now(),
      fragments: [
        { label: "Agent", tokens: 2200 },
        { label: "Skills", tokens: 1000 },
      ],
    }

    const result = analyzeSessionMessages(
      [userMsg, assistantMsg],
      "test-session-6",
      serverSnapshot,
      null,
    )

    const sysCat = result.categories.find((c) => c.name.startsWith("SYSTEM"))
    expect(sysCat).toBeDefined()

    // THE VISOR GATE: entries.length >= 2
    expect(sysCat!.entries.length).toBeGreaterThanOrEqual(2)
    // Verify the gate would pass: the sum of entries matches systemTokens
    const entrySum = sysCat!.entries.reduce((s, e) => s + e.tokens, 0)
    expect(entrySum).toBe(sysCat!.totalTokens)
  })

  // ─── 7. Clean heuristic removed ──────────────────────────────────────────
  it("uses server snapshot even when telemetry has cacheRead > 0", () => {
    const userMsg = makeUserMessage("Hello, how are you?")
    // Telemetry with cache.read > 0 — old behavior would fall to Tier 3 with entries=1
    const assistantMsg = makeAssistantMessage(
      { input: 24000, cache: { read: 64, write: 0 } },
      "I'm fine, thank you!",
    )

    const serverSnapshot: SystemSnapshot = {
      t: 5536,
      ts: Date.now(),
      fragments: [
        { label: "Agent", tokens: 2200 },
        { label: "Skills", tokens: 1000 },
      ],
    }

    const result = analyzeSessionMessages(
      [userMsg, assistantMsg],
      "test-session-7",
      serverSnapshot,
      null,
    )

    const sysCat = result.categories.find((c) => c.name.startsWith("SYSTEM"))
    expect(sysCat).toBeDefined()

    // systemTokens MUST use server value (5536), NOT telemetry
    expect(sysCat!.totalTokens).toBe(5536)
    expect(sysCat!.name).toContain("server")

    // Must have 2+ entries from server fragments
    expect(sysCat!.entries.length).toBeGreaterThanOrEqual(2)

    // TOOL DEFS should still be computed (residual from telemetry)
    const toolDefsCat = result.categories.find((c) => c.name === "TOOL DEFS")
    expect(toolDefsCat).toBeDefined()
    expect(toolDefsCat!.totalTokens).toBeGreaterThan(0)
  })

  // ─── Additional edge cases ──────────────────────────────────────────────

  it("handles server snapshot with no fragments gracefully", () => {
    const userMsg = makeUserMessage("Hello!")
    const assistantMsg = makeAssistantMessage(
      { input: 100 },
      "Hi there!",
    )

    // Server snapshot with no fragments and no rawText
    const serverSnapshot: SystemSnapshot = {
      t: 1000,
      ts: Date.now(),
    }

    const result = analyzeSessionMessages(
      [userMsg, assistantMsg],
      "test-session-no-frags",
      serverSnapshot,
      null,
    )

    const sysCat = result.categories.find((c) => c.name.startsWith("SYSTEM"))
    expect(sysCat).toBeDefined()
    expect(sysCat!.totalTokens).toBe(1000)

    // No fragments → single entry
    expect(sysCat!.entries.length).toBe(1)
    expect(sysCat!.entries[0].label).toBe("System prompt")
  })

  it("skips messages with compaction parts", () => {
    const userMsg = makeUserMessage("Hello!")
    const compactionAssistantMsg = {
      info: {
        role: "assistant" as const,
        providerID: "test-provider",
        modelID: "test-model",
        tokens: { input: 5000, output: 100 },
      },
      parts: [{ type: "compaction" as const }],
    }
    const normalAssistantMsg = makeAssistantMessage(
      { input: 200 },
      "Here you go.",
    )

    const serverSnapshot: SystemSnapshot = {
      t: 1000,
      ts: Date.now(),
      fragments: [{ label: "Agent", tokens: 1000 }],
    }

    const result = analyzeSessionMessages(
      [userMsg, compactionAssistantMsg, normalAssistantMsg],
      "test-session-compaction",
      serverSnapshot,
      null,
    )

    // The first assistant has compaction so it's skipped.
    // The second assistant has input: 200 → this is the firstNonzeroAssistant.
    // Since session was compacted (compaction part exists), tier2 is NOT computed.
    // systemTokens must still come from server.
    const sysCat = result.categories.find((c) => c.name.startsWith("SYSTEM"))
    expect(sysCat).toBeDefined()
    expect(sysCat!.totalTokens).toBe(1000)

    // No TOOL DEFS because tier2 was skipped due to compaction
    expect(result.toolDefsTokens).toBe(0)
  })

  it("sorts categories by totalTokens descending", () => {
    const userMsg = makeUserMessage("Hello, how are you?")
    const assistantMsg = makeAssistantMessage(
      { input: 24000, cache: { read: 64, write: 0 } },
      "I'm fine, thank you!",
    )

    const serverSnapshot: SystemSnapshot = {
      t: 1000,
      ts: Date.now(),
      fragments: [{ label: "Agent", tokens: 1000 }],
    }

    const result = analyzeSessionMessages(
      [userMsg, assistantMsg],
      "test-session-sort",
      serverSnapshot,
      null,
    )

    // Verify categories are sorted by totalTokens descending
    for (let i = 1; i < result.categories.length; i++) {
      expect(result.categories[i].totalTokens)
        .toBeLessThanOrEqual(result.categories[i - 1].totalTokens)
    }
  })

  it("reports correct messageCount", () => {
    const userMsg = makeUserMessage("Hello!")
    const assistantMsg = makeAssistantMessage(
      { input: 100 },
      "Hi!",
    )

    const serverSnapshot: SystemSnapshot = {
      t: 500,
      ts: Date.now(),
      fragments: [{ label: "Agent", tokens: 500 }],
    }

    const result = analyzeSessionMessages(
      [userMsg, assistantMsg],
      "test-session-count",
      serverSnapshot,
      null,
    )

    expect(result.messageCount).toBe(2)
  })

  it("handles empty parts array", () => {
    const result = analyzeSessionMessages(
      [
        { info: { role: "user" as const }, parts: [] },
        {
          info: {
            role: "assistant" as const,
            providerID: "test",
            modelID: "test",
            tokens: { input: 100 },
          },
          parts: [],
        },
      ],
      "test-empty-parts",
      null,
      null,
    )

    // No USER category (empty text from empty parts)
    const userCat = result.categories.find((c) => c.name === "USER")
    expect(userCat).toBeUndefined()
  })

  it("includes sysCat.source info in rawSystemText", () => {
    const serverSnapshot: SystemSnapshot = {
      t: 5536,
      ts: Date.now(),
      fragments: [
        { label: "Agent", tokens: 2200 },
      ],
      rawText: "Instructions from: Agent\nYou are a helpful assistant.",
    }

    const result = analyzeSessionMessages(
      [makeUserMessage("Hello!"), makeAssistantMessage({ input: 100 }, "Hi!")],
      "test-raw-text",
      serverSnapshot,
      null,
    )

    expect(result.rawSystemText).toBe(serverSnapshot.rawText)
  })
})
