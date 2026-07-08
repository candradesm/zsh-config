import { getWeekMonday } from "./helpers/dates"
import type { UsageData, ModelUsage } from "./types"
import { MAX_MODELS, type RawUsageRow } from "./db"
import { type CachePeriod, MS_PER_DAY, getPrevMonthStartMs } from "./cache"

// ─── Types ─────────────────────────────────────────────────────────────────

export type Granularity = "month" | "week" | "day"

// ─── Aggregation ────────────────────────────────────────────────────────────

export function computeUsageDataFromRows(rows: RawUsageRow[]): UsageData {
  const modelMap = new Map<string, ModelUsage>()

  for (const row of rows) {
    if (!row.provider_id || !row.model_id) continue
    const key = `${row.provider_id}/${row.model_id}`
    let existing = modelMap.get(key)
    if (!existing) {
      existing = { providerID: row.provider_id, modelID: row.model_id, totalCost: 0, totalInput: 0, totalOutput: 0 }
      modelMap.set(key, existing)
    }
    existing.totalCost += Math.max(0, row.cost ?? 0)
    existing.totalInput += Math.max(0, row.input_tokens ?? 0)
    existing.totalOutput += Math.max(0, row.output_tokens ?? 0)
  }

  const sorted = [...modelMap.values()]
    .sort((a, b) => (b.totalInput + b.totalOutput) - (a.totalInput + a.totalOutput))
    .slice(0, MAX_MODELS)

  let totalInput = 0
  let totalOutput = 0
  let totalCost = 0
  for (const m of sorted) {
    totalInput += m.totalInput
    totalOutput += m.totalOutput
    totalCost += m.totalCost
  }

  return { models: sorted, totalInput, totalOutput, totalCost }
}

// ─── Hierarchy builder ──────────────────────────────────────────────────────

export function buildHierarchy(rows: RawUsageRow[], monthStartMs: number, monthEndMs: number): CachePeriod {
  const dayMap = new Map<number, CachePeriod>()
  const dayModels = new Map<number, Map<string, { providerID: string; modelID: string; totalCost: number; totalInput: number; totalOutput: number }>>()
  const weekModels = new Map<number, Map<string, { providerID: string; modelID: string; totalCost: number; totalInput: number; totalOutput: number }>>()
  for (const row of rows) {
    const dayMs = Math.floor(row.time_created / MS_PER_DAY) * MS_PER_DAY
    let day = dayMap.get(dayMs)
    if (!day) {
      day = {
        startMs: dayMs,
        endMs: dayMs + MS_PER_DAY,
        inputTokens: 0,
        outputTokens: 0,
        totalCost: 0,
        change: null,
        lastUpdated: Date.now(),
        weeks: null,
        days: null,
        models: null,
      }
      dayMap.set(dayMs, day)
    }
    day.inputTokens += row.input_tokens
    day.outputTokens += row.output_tokens
    day.totalCost += row.cost

    if (row.provider_id && row.model_id) {
      let dm = dayModels.get(dayMs)
      if (!dm) {
        dm = new Map()
        dayModels.set(dayMs, dm)
      }
      const mk = `${row.provider_id}/${row.model_id}`
      let me = dm.get(mk)
      if (!me) {
        me = { providerID: row.provider_id, modelID: row.model_id, totalCost: 0, totalInput: 0, totalOutput: 0 }
        dm.set(mk, me)
      }
      me.totalCost += Math.max(0, row.cost ?? 0)
      me.totalInput += Math.max(0, row.input_tokens ?? 0)
      me.totalOutput += Math.max(0, row.output_tokens ?? 0)
    }

    if (row.provider_id && row.model_id) {
      const wm = getWeekMonday(new Date(row.time_created)).getTime()
      let wmap = weekModels.get(wm)
      if (!wmap) { wmap = new Map(); weekModels.set(wm, wmap) }
      const mk = `${row.provider_id}/${row.model_id}`
      let me = wmap.get(mk)
      if (!me) { me = { providerID: row.provider_id, modelID: row.model_id, totalCost: 0, totalInput: 0, totalOutput: 0 }; wmap.set(mk, me) }
      me.totalCost += Math.max(0, row.cost ?? 0)
      me.totalInput += Math.max(0, row.input_tokens ?? 0)
      me.totalOutput += Math.max(0, row.output_tokens ?? 0)
    }
  }

  const allDays: CachePeriod[] = []
  for (let dayMs = monthStartMs; dayMs < monthEndMs; dayMs += MS_PER_DAY) {
    const existing = dayMap.get(dayMs)
    if (existing) {
      allDays.push(existing)
    } else {
      allDays.push({
        startMs: dayMs,
        endMs: dayMs + MS_PER_DAY,
        inputTokens: 0,
        outputTokens: 0,
        totalCost: 0,
        change: null,
        lastUpdated: Date.now(),
        weeks: null,
        days: null,
        models: [],
      })
    }
  }
  const sortedDays = allDays

  for (const day of sortedDays) {
    const dm = dayModels.get(day.startMs)
    if (dm) {
      day.models = [...dm.values()]
        .sort((a, b) => (b.totalInput + b.totalOutput) - (a.totalInput + a.totalOutput))
        .slice(0, MAX_MODELS)
    } else {
      day.models = []
    }
  }

  const weekMap = new Map<number, { weekMonday: number; days: CachePeriod[] }>()
  for (const day of sortedDays) {
    const wm = getWeekMonday(new Date(day.startMs)).getTime()
    let w = weekMap.get(wm)
    if (!w) {
      w = { weekMonday: wm, days: [] }
      weekMap.set(wm, w)
    }
    w.days.push(day)
  }

  const sortedWeekKeys = [...weekMap.keys()].sort((a, b) => a - b)
  const weeks: CachePeriod[] = sortedWeekKeys.map((wk, i) => {
    const w = weekMap.get(wk)!
    const inputTokens = w.days.reduce((s, d) => s + d.inputTokens, 0)
    const outputTokens = w.days.reduce((s, d) => s + d.outputTokens, 0)
    const totalCost = w.days.reduce((s, d) => s + d.totalCost, 0)

    let change: number | null = null
    if (i > 0) {
      const prev = weekMap.get(sortedWeekKeys[i - 1])!
      const prevTotal = prev.days.reduce((s, d) => s + d.inputTokens + d.outputTokens, 0)
      const currTotal = inputTokens + outputTokens
      if (prevTotal > 0) {
        change = Math.round(((currTotal - prevTotal) / prevTotal) * 100)
      }
    }

    const wmap = weekModels.get(wk)
    const weekModelArr = wmap ? [...wmap.values()]
      .sort((a, b) => (b.totalInput + b.totalOutput) - (a.totalInput + a.totalOutput))
      .slice(0, MAX_MODELS) : []

    return {
      startMs: wk,
      endMs: wk + 7 * MS_PER_DAY,
      inputTokens,
      outputTokens,
      totalCost,
      change,
      lastUpdated: Date.now(),
      weeks: null,
      days: w.days,
      models: weekModelArr,
    }
  })

  const totalInput = weeks.reduce((s, w) => s + w.inputTokens, 0)
  const totalOutput = weeks.reduce((s, w) => s + w.outputTokens, 0)
  const totalCostW = weeks.reduce((s, w) => s + w.totalCost, 0)

  const monthModelMap = new Map<string, ModelUsage>()
  for (const [, dm] of dayModels) {
    for (const [key, model] of dm) {
      const existing = monthModelMap.get(key)
      if (!existing) {
        monthModelMap.set(key, { ...model })
      } else {
        existing.totalCost += model.totalCost
        existing.totalInput += model.totalInput
        existing.totalOutput += model.totalOutput
      }
    }
  }
  const monthModels = [...monthModelMap.values()]
    .sort((a, b) => (b.totalInput + b.totalOutput) - (a.totalInput + a.totalOutput))
    .slice(0, MAX_MODELS)

  return {
    startMs: monthStartMs,
    endMs: monthEndMs,
    inputTokens: totalInput,
    outputTokens: totalOutput,
    totalCost: totalCostW,
    change: null,
    lastUpdated: Date.now(),
    weeks,
    days: sortedDays,
    models: monthModels,
  }
}

// ─── Previous-period lookup ─────────────────────────────────────────────────

export function findPreviousPeriodTotal(
  startMs: number,
  gran: Granularity,
  getCachedMonth: (ms: number) => CachePeriod | undefined
): number | null {
  let previousTotal: number | null = null

  if (gran === "month") {
    const prevStartMs = getPrevMonthStartMs(startMs)
    const prevCached = getCachedMonth(prevStartMs)
    if (prevCached) {
      previousTotal = prevCached.inputTokens + prevCached.outputTokens
    }
  } else {
    const periodMs = gran === "week" ? 7 * MS_PER_DAY : MS_PER_DAY
    const prevStartMs = startMs - periodMs

    const currMonthStart = Date.UTC(new Date(startMs).getUTCFullYear(), new Date(startMs).getUTCMonth(), 1)
    const currCached = getCachedMonth(currMonthStart)
    const periodField: "weeks" | "days" = gran === "week" ? "weeks" : "days"
    const currList = currCached?.[periodField]
    const prevPeriod = currList?.find((p: CachePeriod) => p.startMs === prevStartMs)
    if (prevPeriod) {
      previousTotal = prevPeriod.inputTokens + prevPeriod.outputTokens
    }

    if (previousTotal === null) {
      const prevMonthStart = Date.UTC(new Date(prevStartMs).getUTCFullYear(), new Date(prevStartMs).getUTCMonth(), 1)
      const prevCached = getCachedMonth(prevMonthStart)
      const prevList = prevCached?.[periodField]
      const prevP = prevList?.find((p: CachePeriod) => p.startMs === prevStartMs)
      if (prevP) {
        previousTotal = prevP.inputTokens + prevP.outputTokens
      }
    }
  }

  return previousTotal
}
