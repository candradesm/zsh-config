/**
 * Weekly.test.ts — day/week bucketing logic
 *
 * These tests verify pure bucketing functions (no DB needed) that group raw
 * usage rows into day and week buckets. The functions are defined inline here
 * as the specification for the bucketing logic that will be used by command.tsx.
 *
 * The RawUsageRow type matches the shape returned by fetchRawRows(db.ts) for
 * individual assistant messages within a time range.
 */

import { describe, expect, it } from "bun:test"

// ─── Types ─────────────────────────────────────────────────────────────────────

interface RawUsageRow {
  time_created: number
  model_id: string | null
  provider_id: string | null
  total_cost: number
  total_input: number
  total_output: number
}

interface DayBucket {
  dayMs: number
  totalInput: number
  totalOutput: number
  totalCost: number
  count: number
}

interface WeekBucket {
  startMs: number
  label: string
  totalInput: number
  totalOutput: number
  totalCost: number
  days: DayBucket[]
}

// ─── Helpers (inlined — matches what command.tsx will use) ─────────────────────

function getUTCDayStart(ts: number): number {
  const d = new Date(ts)
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate())
}

function getWeekMonday(ts: number): number {
  const d = new Date(ts)
  const day = d.getUTCDay()
  const offset = day === 0 ? 6 : day - 1
  const monday = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - offset))
  return Date.UTC(monday.getUTCFullYear(), monday.getUTCMonth(), monday.getUTCDate())
}

function formatWeekLabel(startMs: number): string {
  const start = new Date(startMs)
  const end = new Date(startMs + 6 * 24 * 60 * 60 * 1000)
  const opts: Intl.DateTimeFormatOptions = { month: "short", day: "numeric", timeZone: "UTC" }
  return `${start.toLocaleDateString("en-US", opts)} – ${end.toLocaleDateString("en-US", opts)}`
}

function bucketByDay(rows: RawUsageRow[]): DayBucket[] {
  const map = new Map<number, DayBucket>()

  for (const row of rows) {
    const dayMs = getUTCDayStart(row.time_created)
    const existing = map.get(dayMs)
    if (existing) {
      existing.totalInput += Math.max(0, row.total_input)
      existing.totalOutput += Math.max(0, row.total_output)
      existing.totalCost += Math.max(0, row.total_cost)
      existing.count++
    } else {
      map.set(dayMs, {
        dayMs,
        totalInput: Math.max(0, row.total_input),
        totalOutput: Math.max(0, row.total_output),
        totalCost: Math.max(0, row.total_cost),
        count: 1,
      })
    }
  }

  return Array.from(map.values()).sort((a, b) => a.dayMs - b.dayMs)
}

function bucketByWeek(rows: RawUsageRow[]): WeekBucket[] {
  const days = bucketByDay(rows)
  const map = new Map<number, DayBucket[]>()

  for (const day of days) {
    const startMs = getWeekMonday(day.dayMs)
    const existing = map.get(startMs)
    if (existing) {
      existing.push(day)
    } else {
      map.set(startMs, [day])
    }
  }

  return Array.from(map.entries())
    .sort(([a], [b]) => a - b)
    .map(([startMs, dayBuckets]) => {
      const totalInput = dayBuckets.reduce((s, d) => s + d.totalInput, 0)
      const totalOutput = dayBuckets.reduce((s, d) => s + d.totalOutput, 0)
      const totalCost = dayBuckets.reduce((s, d) => s + d.totalCost, 0)
      return {
        startMs,
        label: formatWeekLabel(startMs),
        totalInput,
        totalOutput,
        totalCost,
        days: dayBuckets,
      }
    })
}

// ─── Tests: bucketByDay ────────────────────────────────────────────────────────

describe("bucketByDay", () => {
  const REFERENCE = Date.UTC(2026, 6, 6, 12, 0, 0)

  it("single message produces 1 day bucket with correct totals", () => {
    const rows: RawUsageRow[] = [
      { time_created: REFERENCE, model_id: "gpt-4", provider_id: "copilot", total_cost: 0.05, total_input: 100, total_output: 50 },
    ]
    const result = bucketByDay(rows)
    expect(result).toHaveLength(1)
    expect(result[0].dayMs).toBe(Date.UTC(2026, 6, 6))
    expect(result[0].totalInput).toBe(100)
    expect(result[0].totalOutput).toBe(50)
    expect(result[0].totalCost).toBeCloseTo(0.05, 6)
    expect(result[0].count).toBe(1)
  })

  it("multiple messages in same day are aggregated into 1 day bucket", () => {
    const rows: RawUsageRow[] = [
      { time_created: REFERENCE, model_id: "gpt-4", provider_id: "copilot", total_cost: 0.05, total_input: 100, total_output: 50 },
      { time_created: REFERENCE + 3600_000, model_id: "claude-3", provider_id: "anthropic", total_cost: 0.03, total_input: 200, total_output: 100 },
    ]
    const result = bucketByDay(rows)
    expect(result).toHaveLength(1)
    expect(result[0].totalInput).toBe(300)
    expect(result[0].totalOutput).toBe(150)
    expect(result[0].totalCost).toBeCloseTo(0.08, 6)
    expect(result[0].count).toBe(2)
  })

  it("messages across 3 days produce 3 day buckets", () => {
    const day1 = Date.UTC(2026, 6, 6, 10, 0, 0)
    const day2 = Date.UTC(2026, 6, 7, 10, 0, 0)
    const day3 = Date.UTC(2026, 6, 8, 10, 0, 0)

    const rows: RawUsageRow[] = [
      { time_created: day1, model_id: "gpt-4", provider_id: "copilot", total_cost: 0.05, total_input: 100, total_output: 50 },
      { time_created: day2, model_id: "claude-3", provider_id: "anthropic", total_cost: 0.03, total_input: 200, total_output: 100 },
      { time_created: day3, model_id: "gpt-4", provider_id: "copilot", total_cost: 0.07, total_input: 300, total_output: 150 },
    ]
    const result = bucketByDay(rows)
    expect(result).toHaveLength(3)
    expect(result[0].count).toBe(1)
    expect(result[1].count).toBe(1)
    expect(result[2].count).toBe(1)
    expect(result[0].dayMs).toBeLessThan(result[1].dayMs)
    expect(result[1].dayMs).toBeLessThan(result[2].dayMs)
  })
})

// ─── Tests: bucketByWeek ───────────────────────────────────────────────────────

describe("bucketByWeek", () => {
  it("messages across 2 ISO weeks produce 2 week buckets", () => {
    const week1 = Date.UTC(2026, 6, 8, 12, 0, 0)
    const week2 = Date.UTC(2026, 6, 15, 12, 0, 0)

    const rows: RawUsageRow[] = [
      { time_created: week1, model_id: "gpt-4", provider_id: "copilot", total_cost: 0.05, total_input: 100, total_output: 50 },
      { time_created: week2, model_id: "claude-3", provider_id: "anthropic", total_cost: 0.03, total_input: 200, total_output: 100 },
    ]
    const result = bucketByWeek(rows)
    expect(result).toHaveLength(2)
    expect(result[0].startMs).toBe(Date.UTC(2026, 6, 6))
    expect(result[1].startMs).toBe(Date.UTC(2026, 6, 13))
  })

  it('cross-month week: messages on Jun 29 (Mon) and Jul 5 (Sun) → 1 week bucket "Jun 29 – Jul 5"', () => {
    const jun29 = Date.UTC(2026, 5, 29, 10, 0, 0)
    const jul5 = Date.UTC(2026, 6, 5, 14, 0, 0)

    const rows: RawUsageRow[] = [
      { time_created: jun29, model_id: "gpt-4", provider_id: "copilot", total_cost: 0.05, total_input: 100, total_output: 50 },
      { time_created: jul5, model_id: "claude-3", provider_id: "anthropic", total_cost: 0.03, total_input: 200, total_output: 100 },
    ]
    const result = bucketByWeek(rows)
    expect(result).toHaveLength(1)
    expect(result[0].startMs).toBe(Date.UTC(2026, 5, 29))
    expect(result[0].label).toBe("Jun 29 – Jul 5")
    expect(result[0].days).toHaveLength(2)
    expect(result[0].totalInput).toBe(300)
    expect(result[0].totalOutput).toBe(150)
    expect(result[0].totalCost).toBeCloseTo(0.08, 6)
  })

  it("verify week Monday ownership: a message on Jul 5 buckets into the week starting Jun 29", () => {
    const jul5 = Date.UTC(2026, 6, 5, 12, 0, 0)
    const rows: RawUsageRow[] = [
      { time_created: jul5, model_id: "gpt-4", provider_id: "copilot", total_cost: 0.05, total_input: 100, total_output: 50 },
    ]
    const result = bucketByWeek(rows)
    expect(result).toHaveLength(1)
    expect(result[0].startMs).toBe(Date.UTC(2026, 5, 29))
  })

  it("verify cost aggregation across days and weeks", () => {
    const rows: RawUsageRow[] = [
      { time_created: Date.UTC(2026, 6, 6, 10, 0, 0), model_id: "gpt-4", provider_id: "copilot", total_cost: 0.10, total_input: 500, total_output: 250 },
      { time_created: Date.UTC(2026, 6, 7, 10, 0, 0), model_id: "claude-3", provider_id: "anthropic", total_cost: 0.05, total_input: 200, total_output: 100 },
      { time_created: Date.UTC(2026, 6, 14, 10, 0, 0), model_id: "gpt-4", provider_id: "copilot", total_cost: 0.20, total_input: 1000, total_output: 500 },
    ]

    const weeks = bucketByWeek(rows)
    expect(weeks).toHaveLength(2)

    expect(weeks[0].totalInput).toBe(700)
    expect(weeks[0].totalOutput).toBe(350)
    expect(weeks[0].totalCost).toBeCloseTo(0.15, 6)
    expect(weeks[0].days).toHaveLength(2)

    expect(weeks[1].totalInput).toBe(1000)
    expect(weeks[1].totalOutput).toBe(500)
    expect(weeks[1].totalCost).toBeCloseTo(0.20, 6)
    expect(weeks[1].days).toHaveLength(1)
  })

  it("empty raw rows produce empty buckets", () => {
    const result = bucketByWeek([])
    expect(result).toEqual([])
  })

  it("empty raw rows produce empty day buckets", () => {
    const result = bucketByDay([])
    expect(result).toEqual([])
  })
})
