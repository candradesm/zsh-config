import { describe, expect, it } from "bun:test"
import { estimateTokens, rawPromptTokens, scaleEntries } from "./helpers/tokens"
import { splitSystemFragments } from "./helpers/fragments"
import { loadBaseline } from "./db"

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

  it("splits on markdown headers", () => {
    const text = "# Title\nbody1\n## Sub\nbody2\n# Another\nbody3"
    const frags = splitSystemFragments(text)
    expect(frags.length).toBe(3)
    expect(frags.some((f) => f.label === "Title")).toBe(true)
    expect(frags.some((f) => f.label === "Sub")).toBe(true)
    expect(frags.some((f) => f.label === "Another")).toBe(true)
  })

  it("splits on jungle-mode 'Instructions from:' marker", () => {
    const text = "Instructions from: jungle-mode/persona\npersona text\n# Env\nenv body"
    const frags = splitSystemFragments(text)
    expect(frags.some((f) => f.label === "jungle-mode/persona")).toBe(true)
    expect(frags.some((f) => f.label === "Env")).toBe(true)
  })

  it("buckets preamble before any header", () => {
    const text = "preamble line\n# Header\nbody"
    const frags = splitSystemFragments(text)
    expect(frags.some((f) => f.label === "preamble")).toBe(true)
  })

  it("caps to top-N + other", () => {
    let text = ""
    for (let i = 0; i < 15; i++) text += `# Section ${i}\n${"x".repeat((i + 1) * 100)}\n`
    const frags = splitSystemFragments(text, 10)
    expect(frags.length).toBe(11) // 10 kept + "other"
    expect(frags[frags.length - 1].label).toBe("other")
  })

  it("sorts by tokens descending", () => {
    const text = "# Small\nab\n# Big\n" + "x".repeat(1000)
    const frags = splitSystemFragments(text)
    expect(frags[0].tokens).toBeGreaterThanOrEqual(frags[1].tokens)
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
