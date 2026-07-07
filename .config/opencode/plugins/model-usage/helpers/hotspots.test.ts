import { describe, expect, it } from "bun:test"
import { median, detectHotspots, summarizeToolInput, shortenPath, type HotspotCandidate } from "./hotspots"

// ─── median ──────────────────────────────────────────────────────────────────

describe("median", () => {
  it("returns 0 for an empty array", () => {
    expect(median([])).toBe(0)
  })

  it("returns the value for a single-element array", () => {
    expect(median([42])).toBe(42)
  })

  it("returns the average of two middle values for an even-length array", () => {
    expect(median([10, 20])).toBe(15)
    expect(median([1, 5, 10, 100])).toBe(7.5) // (5 + 10) / 2
  })

  it("returns the middle value for an odd-length array", () => {
    expect(median([1, 5, 10])).toBe(5)
  })

  it("handles unsorted inputs correctly by sorting internally first", () => {
    expect(median([10, 1, 5])).toBe(5) // sorts to [1, 5, 10]
    expect(median([100, 10, 1, 5])).toBe(7.5) // sorts to [1, 5, 10, 100]
  })

  it("handles arrays with duplicate values", () => {
    expect(median([10, 10, 10])).toBe(10)
    expect(median([10, 20, 20, 30])).toBe(20)
  })
})

// ─── detectHotspots ──────────────────────────────────────────────────────────

describe("detectHotspots", () => {
  it("detects a clear outlier (>2x median) with correct ratio and passes fields through", () => {
    const candidates: HotspotCandidate[] = [
      { category: "catA", label: "l1", tokens: 10, preview: "p1", fullText: "f1" },
      { category: "catA", label: "l2", tokens: 12, preview: "p2", fullText: "f2" },
      { category: "catA", label: "l3", tokens: 15, preview: "p3", fullText: "f3" },
      { category: "catA", label: "l4", tokens: 100, preview: "p4", fullText: "f4" }, // median = 13.5, 2x median = 27. 100 is outlier.
    ]

    const results = detectHotspots({ catA: candidates })
    expect(results.length).toBe(1)
    expect(results[0].category).toBe("catA")
    expect(results[0].label).toBe("l4")
    expect(results[0].tokens).toBe(100)
    expect(results[0].preview).toBe("p4")
    expect(results[0].fullText).toBe("f4")
    expect(results[0].ratio).toBe(100 / 13.5)
  })

  it("returns nothing when no candidate exceeds the threshold", () => {
    const candidates: HotspotCandidate[] = [
      { category: "catA", label: "l1", tokens: 10, preview: "p1", fullText: "f1" },
      { category: "catA", label: "l2", tokens: 12, preview: "p2", fullText: "f2" },
      { category: "catA", label: "l3", tokens: 15, preview: "p3", fullText: "f3" },
    ]

    const results = detectHotspots({ catA: candidates })
    expect(results.length).toBe(0)
  })

  it("returns nothing for a category with all-zero tokens (median = 0)", () => {
    const candidates: HotspotCandidate[] = [
      { category: "catA", label: "l1", tokens: 0, preview: "p1", fullText: "f1" },
      { category: "catA", label: "l2", tokens: 0, preview: "p2", fullText: "f2" },
      { category: "catA", label: "l3", tokens: 0, preview: "p3", fullText: "f3" },
    ]

    const results = detectHotspots({ catA: candidates })
    expect(results.length).toBe(0)
  })

  it("merges results across multiple categories and sorts by ratio descending", () => {
    const catACandidates: HotspotCandidate[] = [
      { category: "catA", label: "lA1", tokens: 10, preview: "p1", fullText: "f1" },
      { category: "catA", label: "lA2", tokens: 12, preview: "p2", fullText: "f2" },
      { category: "catA", label: "lA3", tokens: 15, preview: "p3", fullText: "f3" },
      { category: "catA", label: "lA4", tokens: 100, preview: "p4", fullText: "f4" }, // median = 13.5, ratio = 100 / 13.5 ≈ 7.4
    ]

    const catBCandidates: HotspotCandidate[] = [
      { category: "catB", label: "lB1", tokens: 50, preview: "p1", fullText: "f1" },
      { category: "catB", label: "lB2", tokens: 60, preview: "p2", fullText: "f2" },
      { category: "catB", label: "lB3", tokens: 70, preview: "p3", fullText: "f3" },
      { category: "catB", label: "lB4", tokens: 1000, preview: "p4", fullText: "f4" }, // median = 65, ratio = 1000 / 65 ≈ 15.38
    ]

    const results = detectHotspots({ catA: catACandidates, catB: catBCandidates })
    expect(results.length).toBe(2)
    expect(results[0].category).toBe("catB")
    expect(results[0].label).toBe("lB4")
    expect(results[0].ratio).toBeCloseTo(15.3846, 2)
    expect(results[1].category).toBe("catA")
    expect(results[1].label).toBe("lA4")
    expect(results[1].ratio).toBeCloseTo(7.4074, 2)
  })

  it("respects a custom multiplier option", () => {
    const candidates: HotspotCandidate[] = [
      { category: "catA", label: "l1", tokens: 10, preview: "p1", fullText: "f1" },
      { category: "catA", label: "l2", tokens: 12, preview: "p2", fullText: "f2" },
      { category: "catA", label: "l3", tokens: 15, preview: "p3", fullText: "f3" },
      { category: "catA", label: "l4", tokens: 40, preview: "p4", fullText: "f4" }, // median = 13.5, 2.5x median = 33.75, 3x median = 40.5.
    ]

    // With multiplier 3: 40 is not > 40.5
    const resultsMul3 = detectHotspots({ catA: candidates }, { multiplier: 3 })
    expect(resultsMul3.length).toBe(0)

    // With multiplier 2.5: 40 > 33.75
    const resultsMul2_5 = detectHotspots({ catA: candidates }, { multiplier: 2.5 })
    expect(resultsMul2_5.length).toBe(1)
    expect(resultsMul2_5[0].label).toBe("l4")
  })

  it("respects a custom cap option", () => {
    // 3 candidates qualify as outliers with median = 10 (since we have 5 base items of 10)
    // ratios:
    // l1: 1000 / 10 = 100
    // l2: 500 / 10 = 50
    // l3: 300 / 10 = 30
    const candidates: HotspotCandidate[] = [
      { category: "catA", label: "base1", tokens: 10, preview: "p", fullText: "f" },
      { category: "catA", label: "base2", tokens: 10, preview: "p", fullText: "f" },
      { category: "catA", label: "base3", tokens: 10, preview: "p", fullText: "f" },
      { category: "catA", label: "base4", tokens: 10, preview: "p", fullText: "f" },
      { category: "catA", label: "base5", tokens: 10, preview: "p", fullText: "f" },
      { category: "catA", label: "l1", tokens: 1000, preview: "p", fullText: "f" },
      { category: "catA", label: "l2", tokens: 500, preview: "p", fullText: "f" },
      { category: "catA", label: "l3", tokens: 300, preview: "p", fullText: "f" },
    ]

    const results = detectHotspots({ catA: candidates }, { cap: 2 })
    expect(results.length).toBe(2)
    expect(results[0].label).toBe("l1")
    expect(results[1].label).toBe("l2")
  })

  it("respects default cap of 5", () => {
    // Create 7 candidates that qualify as outliers with median = 10 (since we have 10 base items of 10)
    const candidates: HotspotCandidate[] = [
      ...Array.from({ length: 10 }, (_, i) => ({
        category: "catA",
        label: `base-${i}`,
        tokens: 10,
        preview: "p",
        fullText: "f",
      })),
      ...Array.from({ length: 7 }, (_, i) => ({
        category: "catA",
        label: `outlier-${i}`,
        tokens: 100 + i * 10,
        preview: "p",
        fullText: "f",
      })),
    ]

    const results = detectHotspots({ catA: candidates })
    expect(results.length).toBe(5)
  })
})

// ─── summarizeToolInput ──────────────────────────────────────────────────────

describe("summarizeToolInput", () => {
  it("returns null if input is undefined or null", () => {
    expect(summarizeToolInput("someTool", undefined)).toBeNull()
    expect(summarizeToolInput("someTool", null)).toBeNull()
  })

  it("returns null if input is an empty object", () => {
    expect(summarizeToolInput("someTool", {})).toBeNull()
  })

  it("returns null if input is not an object or is an array", () => {
    // @ts-expect-error - testing invalid types
    expect(summarizeToolInput("someTool", "string")).toBeNull()
    // @ts-expect-error - testing invalid types
    expect(summarizeToolInput("someTool", 123)).toBeNull()
    // @ts-expect-error - testing invalid types
    expect(summarizeToolInput("someTool", [])).toBeNull()
  })

  it("respects key priority order: filePath beats path", () => {
    const input = { filePath: "src/main.ts", path: "src/other.ts" }
    expect(summarizeToolInput("someTool", input)).toBe("src/main.ts")
  })

  it("respects key priority order: path beats pattern", () => {
    const input = { path: "src/main.ts", pattern: "*.ts" }
    expect(summarizeToolInput("someTool", input)).toBe("src/main.ts")
  })

  it("respects key priority order: pattern beats command", () => {
    const input = { pattern: "*.ts", command: "echo test" }
    expect(summarizeToolInput("someTool", input)).toBe("*.ts")
  })

  it("respects key priority order: command beats url", () => {
    const input = { command: "echo test", url: "https://example.com" }
    expect(summarizeToolInput("someTool", input)).toBe("echo test")
  })

  it("respects key priority order: url beats description", () => {
    const input = { url: "https://example.com", description: "Useful site" }
    expect(summarizeToolInput("someTool", input)).toBe("https://example.com")
  })

  it("respects key priority order: description beats prompt", () => {
    const input = { description: "Useful site", prompt: "Summarize this" }
    expect(summarizeToolInput("someTool", input)).toBe("Useful site")
  })

  it("respects key priority order: prompt is returned when only prompt is present", () => {
    const input = { prompt: "Summarize this" }
    expect(summarizeToolInput("someTool", input)).toBe("Summarize this")
  })

  it("skips non-string values and falls through to next priority key", () => {
    const input = {
      filePath: 123, // not a string, skip
      path: true,    // not a string, skip
      pattern: "src/**/*.ts", // string, return this
      command: "npm test"
    }
    expect(summarizeToolInput("someTool", input as any)).toBe("src/**/*.ts")
  })

  it("returns null when no matching priority keys are present", () => {
    const input = { otherKey: "unrelated value", randomField: "not tracked" }
    expect(summarizeToolInput("someTool", input)).toBeNull()
  })

  it("is unaffected by the toolName parameter", () => {
    const input = { command: "npm test" }
    expect(summarizeToolInput("toolA", input)).toBe("npm test")
    expect(summarizeToolInput("toolB", input)).toBe("npm test")
  })
})

// ─── shortenPath ─────────────────────────────────────────────────────────────

describe("shortenPath", () => {
  it("keeps the last 2 components with '…/' prefix for long absolute unix paths", () => {
    expect(shortenPath("/Users/foo/bar/baz/qux.ts")).toBe("…/baz/qux.ts")
    expect(shortenPath("/var/log/nginx/access.log")).toBe("…/nginx/access.log")
  })

  it("returns path unchanged if it has exactly 'segments' components", () => {
    // With default 2 segments
    expect(shortenPath("baz/qux.ts")).toBe("baz/qux.ts")
    expect(shortenPath("/baz/qux.ts")).toBe("/baz/qux.ts") // split/filter returns ["baz", "qux.ts"] (length 2), so unchanged
  })

  it("returns path unchanged if it has fewer than 'segments' components", () => {
    // With default 2 segments
    expect(shortenPath("/qux.ts")).toBe("/qux.ts") // split/filter returns ["qux.ts"] (length 1), so unchanged
  })

  it("correctly handles windows-style path with backslashes", () => {
    expect(shortenPath("C:\\Users\\foo\\bar\\baz\\qux.ts")).toBe("…\\baz\\qux.ts")
    expect(shortenPath("foo\\bar")).toBe("foo\\bar") // exactly 2 segments, unchanged
    expect(shortenPath("\\foo")).toBe("\\foo") // 1 segment, unchanged
  })

  it("returns unchanged for plain strings with no separators", () => {
    expect(shortenPath("npm test")).toBe("npm test")
    expect(shortenPath("hello")).toBe("hello")
  })

  it("respects custom segments value", () => {
    const longPath = "/Users/foo/bar/baz/qux.ts"
    expect(shortenPath(longPath, 3)).toBe("…/bar/baz/qux.ts")
    expect(shortenPath(longPath, 4)).toBe("…/foo/bar/baz/qux.ts")
    expect(shortenPath(longPath, 5)).toBe(longPath) // exactly 5 components (excluding leading slash), unchanged
    expect(shortenPath(longPath, 6)).toBe(longPath) // fewer components, unchanged
  })

  it("handles empty string without throwing", () => {
    expect(shortenPath("")).toBe("")
  })
})