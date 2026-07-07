import { describe, expect, it } from "bun:test"
import { estimateVisibleOutputTokens } from "./tokens"

describe("estimateVisibleOutputTokens", () => {
  it("handles null, undefined, or empty parts gracefully", () => {
    expect(estimateVisibleOutputTokens(null)).toBe(0)
    expect(estimateVisibleOutputTokens(undefined)).toBe(0)
    expect(estimateVisibleOutputTokens([])).toBe(0)
  })

  it("only counts parts of type 'text'", () => {
    const parts = [
      { type: "text", text: "Hello" }, // 5 chars
      { type: "tool-call", text: "some tool call" }, // should be ignored
      { type: "tool-result", text: "some tool result" }, // should be ignored
      { type: "compaction", text: "some compaction" }, // should be ignored
      { type: "text", text: " World" }, // 5 chars
    ]
    // Total text: "Hello World" (11 chars)
    // 11 / 4 = 2.75 -> Math.ceil(2.75) = 3
    expect(estimateVisibleOutputTokens(parts)).toBe(3)
  })

  it("handles missing or malformed text fields in text parts", () => {
    const parts = [
      { type: "text", text: "Abcd" }, // 4 chars -> 1 token
      { type: "text" }, // missing text field, should treat text as ""
      { type: "text", text: null }, // null text field, should treat text as ""
      { type: "text", text: undefined }, // undefined text field, should treat text as ""
    ]
    expect(estimateVisibleOutputTokens(parts)).toBe(1)
  })

  it("handles malformed part objects gracefully", () => {
    const parts = [
      null,
      undefined,
      "not an object",
      { text: "no type field" },
      { type: "text", text: "12345" }, // 5 chars -> 2 tokens
    ]
    expect(estimateVisibleOutputTokens(parts)).toBe(2)
  })

  it("calculates exact tokens using Math.ceil(text.length / 4)", () => {
    expect(estimateVisibleOutputTokens([{ type: "text", text: "a" }])).toBe(1)
    expect(estimateVisibleOutputTokens([{ type: "text", text: "abcd" }])).toBe(1)
    expect(estimateVisibleOutputTokens([{ type: "text", text: "abcde" }])).toBe(2)
    expect(estimateVisibleOutputTokens([{ type: "text", text: "a".repeat(400) }])).toBe(100)
  })
})
