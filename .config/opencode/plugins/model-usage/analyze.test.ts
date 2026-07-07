import { describe, expect, it } from "bun:test"
import { estimateTokens, rawPromptTokens, scaleEntries } from "./helpers/tokens"
import { splitSystemFragments } from "./helpers/fragments"
import { loadBaseline } from "./db"
import { truncateLabel } from "./helpers/format"

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
    expect(frags[frags.length - 1].label).toBe("other")
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
