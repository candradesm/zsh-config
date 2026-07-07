import { describe, expect, it } from "bun:test"
import { getWeekMonday, getWeekInfo } from "@model-usage/helpers/dates"
import { formatPercentDiff } from "@model-usage/helpers/format"

describe("getWeekMonday", () => {
  it("a known Monday returns itself", () => {
    const d = new Date(Date.UTC(2026, 6, 6))
    const monday = getWeekMonday(d)
    const expected = Date.UTC(2026, 6, 6)
    expect(monday.getTime()).toBe(expected)
  })

  it("a Tuesday returns the previous Monday", () => {
    const d = new Date(Date.UTC(2026, 6, 7))
    const monday = getWeekMonday(d)
    expect(monday.getTime()).toBe(Date.UTC(2026, 6, 6))
  })

  it("a Sunday returns the previous Monday (same week)", () => {
    const d = new Date(Date.UTC(2026, 6, 12))
    const monday = getWeekMonday(d)
    expect(monday.getTime()).toBe(Date.UTC(2026, 6, 6))
  })

  it("month boundary: Jul 1 2026 (Wednesday) → Jun 29 2026 (Monday)", () => {
    const d = new Date(Date.UTC(2026, 6, 1))
    const monday = getWeekMonday(d)
    expect(monday.getTime()).toBe(Date.UTC(2026, 5, 29))
  })

  it("year boundary: Jan 1 2026 (Thursday) → Dec 29 2025 (Monday)", () => {
    const d = new Date(Date.UTC(2026, 0, 1))
    const monday = getWeekMonday(d)
    expect(monday.getTime()).toBe(Date.UTC(2025, 11, 29))
  })

  it("multiple dates in the same week return the same Monday", () => {
    const mon = getWeekMonday(new Date(Date.UTC(2026, 6, 6)))
    const wed = getWeekMonday(new Date(Date.UTC(2026, 6, 8)))
    const sun = getWeekMonday(new Date(Date.UTC(2026, 6, 12)))
    expect(wed.getTime()).toBe(mon.getTime())
    expect(sun.getTime()).toBe(mon.getTime())
  })

  it("edge case: date at exactly 00:00 UTC", () => {
    const d = new Date(Date.UTC(2026, 6, 6, 0, 0, 0, 0))
    const monday = getWeekMonday(d)
    expect(monday.getTime()).toBe(Date.UTC(2026, 6, 6))
  })
})

describe("getWeekInfo", () => {
  it("returns correct startMs (Monday 00:00 UTC)", () => {
    const info = getWeekInfo(new Date(Date.UTC(2026, 6, 8)))
    expect(info.startMs).toBe(Date.UTC(2026, 6, 6))
  })

  it("returns correct endMs (startMs + 7 days)", () => {
    const info = getWeekInfo(new Date(Date.UTC(2026, 6, 8)))
    expect(info.endMs).toBe(Date.UTC(2026, 6, 13))
  })

  it('label format: "Jul 6 – Jul 12" for a July week', () => {
    const info = getWeekInfo(new Date(Date.UTC(2026, 6, 6)))
    expect(info.label).toBe("Jul 6 – Jul 12")
  })

  it('cross-month week label: "Jun 29 – Jul 5" when week straddles months', () => {
    const info = getWeekInfo(new Date(Date.UTC(2026, 5, 29)))
    expect(info.label).toBe("Jun 29 – Jul 5")
  })

  it("current date returns the current week's info", () => {
    const now = new Date()
    const info = getWeekInfo(now)
    expect(info.startMs).toBeLessThanOrEqual(now.getTime())
    expect(info.endMs).toBeGreaterThan(now.getTime())
    expect(info.endMs - info.startMs).toBe(7 * 24 * 60 * 60 * 1000)
    expect(typeof info.label).toBe("string")
    expect(info.label.length).toBeGreaterThan(0)
  })
})

describe("formatPercentDiff", () => {
  it("current > previous: shows ▲ with positive percent", () => {
    expect(formatPercentDiff(150, 100)).toEqual({ arrow: "▲", text: "+50%" })
  })

  it("current < previous: shows ▼ with negative percent", () => {
    expect(formatPercentDiff(50, 100)).toEqual({ arrow: "▼", text: "-50%" })
  })

  it("no change: shows — for both arrow and text", () => {
    expect(formatPercentDiff(100, 100)).toEqual({ arrow: "—", text: "—" })
  })

  it("previous is null: shows — for both arrow and text", () => {
    expect(formatPercentDiff(100, null)).toEqual({ arrow: "—", text: "—" })
  })

  it("previous is 0: shows — (avoid division by zero)", () => {
    expect(formatPercentDiff(100, 0)).toEqual({ arrow: "—", text: "—" })
  })

  it("large increase: current=1000, previous=10 → +9900%", () => {
    expect(formatPercentDiff(1000, 10)).toEqual({ arrow: "▲", text: "+9900%" })
  })

  it("very small decrease: current=99, previous=100 → -1%", () => {
    expect(formatPercentDiff(99, 100)).toEqual({ arrow: "▼", text: "-1%" })
  })

  it("current=0, previous=100 → -100%", () => {
    expect(formatPercentDiff(0, 100)).toEqual({ arrow: "▼", text: "-100%" })
  })
})
