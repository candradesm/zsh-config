/** @jsxImportSource @opentui/solid */
import type { TuiPluginApi } from "@opencode-ai/plugin/tui"
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs"
import { homedir } from "node:os"

import { onMount, onCleanup, createSignal } from "solid-js"
import { getMonthInfo, isCurrentMonth, getWeekMonday, getWeekInfo } from "./helpers/dates"
import { fmt, fmtCost, buildBar, formatPercentDiff } from "./helpers/format"
import type { UsageData, ModelUsage } from "./types"
import { getEarliestUsageDate, fetchRawRows, type RawUsageRow } from "./db"
import { makeScrollState } from "./shared/scroll"
import { registerDialogKeyLayer } from "./shared/keys"

const MS_PER_DAY = 86_400_000
const CACHE_TTL_MS = 60_000

// ─── Types ─────────────────────────────────────────────────────────────────
type Granularity = "month" | "week" | "day"

interface CachePeriod {
  startMs: number
  endMs: number
  inputTokens: number
  outputTokens: number
  totalCost: number
  change: number | null
  lastUpdated: number
  weeks: CachePeriod[] | null
  days: CachePeriod[] | null
  models: ModelUsage[] | null
}

interface UsageCache {
  version: number
  months: Record<string, CachePeriod>
}

// ─── Persistent multi-month cache ─────────────────────────────────────────
const CACHE_DIR = `${homedir()}/.config/opencode/plugins/model-usage`
const CACHE_FILE = `${CACHE_DIR}/.usage-cache.json`

let usageCache: UsageCache = { version: 2, months: {} }

function ensureCacheDir() {
  try { mkdirSync(CACHE_DIR, { recursive: true }) } catch { /* ignore */ }
}

function loadDiskCache() {
  ensureCacheDir()
  try {
    if (existsSync(CACHE_FILE)) {
      const raw = readFileSync(CACHE_FILE, "utf-8")
      const data = JSON.parse(raw)
      if (data.version === 2 && data.months) {
        usageCache = data as UsageCache
      }
    }
  } catch { /* ignore */ }
}

function saveDiskCache() {
  ensureCacheDir()
  try {
    writeFileSync(CACHE_FILE, JSON.stringify(usageCache, null, 2))
  } catch { /* ignore */ }
}

function getMonthCache(startMs: number): CachePeriod | undefined {
  return usageCache.months[String(startMs)]
}

// Load on module init
loadDiskCache()

// ─── Helpers ────────────────────────────────────────────────────────────────

function computeUsageDataFromRows(rows: RawUsageRow[]): UsageData {
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
    .slice(0, 10)

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

function buildHierarchy(rows: RawUsageRow[], monthStartMs: number, monthEndMs: number): CachePeriod {
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
        .slice(0, 10)
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
      .slice(0, 10) : []

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

  const monthModels = computeUsageDataFromRows(rows).models

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

function updateMonthCache(period: CachePeriod) {
  const key = String(period.startMs)

  const prevDate = new Date(period.startMs)
  let prevMonth = prevDate.getUTCMonth() - 1
  let prevYear = prevDate.getUTCFullYear()
  if (prevMonth < 0) { prevMonth = 11; prevYear-- }
  const prevMonthStartMs = Date.UTC(prevYear, prevMonth, 1)
  const prevEntry = usageCache.months[String(prevMonthStartMs)]
  if (prevEntry) {
    const prevTotal = prevEntry.inputTokens + prevEntry.outputTokens
    const currTotal = period.inputTokens + period.outputTokens
    if (prevTotal > 0) {
      period.change = Math.round(((currTotal - prevTotal) / prevTotal) * 100)
    }
  }

  if (period.weeks && period.weeks.length > 0) {
    const firstWeek = period.weeks[0]
    if (firstWeek.change === null && prevEntry?.weeks?.length) {
      const lastWeek = prevEntry.weeks[prevEntry.weeks.length - 1]
      const lastWeekTotal = lastWeek.inputTokens + lastWeek.outputTokens
      const firstWeekTotal = firstWeek.inputTokens + firstWeek.outputTokens
      if (lastWeekTotal > 0) {
        firstWeek.change = Math.round(((firstWeekTotal - lastWeekTotal) / lastWeekTotal) * 100)
      }
    }
  }

  usageCache.months[key] = period

  let nextMonth = prevDate.getUTCMonth() + 1
  let nextYear = prevDate.getUTCFullYear()
  if (nextMonth > 11) { nextMonth = 0; nextYear++ }
  const nextMonthStartMs = Date.UTC(nextYear, nextMonth, 1)
  const nextEntry = usageCache.months[String(nextMonthStartMs)]
  if (nextEntry) {
    const currTotal = period.inputTokens + period.outputTokens
    const nextTotal = nextEntry.inputTokens + nextEntry.outputTokens
    if (currTotal > 0) {
      nextEntry.change = Math.round(((nextTotal - currTotal) / currTotal) * 100)
    }
  }

  saveDiskCache()
}

function getPrevMonthStartMs(ms: number): number {
  const d = new Date(ms)
  let m = d.getUTCMonth() - 1
  let y = d.getUTCFullYear()
  if (m < 0) { m = 11; y-- }
  return Date.UTC(y, m, 1)
}

export function registerUsageCommand(api: TuiPluginApi) {
  api.keymap.registerLayer({
    commands: [
      {
        name: "usage.show",
        title: "Show Monthly Usage",
        category: "Plugin",
        namespace: "palette",
        slashName: "usage",
        async run() {
          const theme = api.theme.current
          const dbPath = `${homedir()}/.local/share/opencode/opencode.db`
          const now = new Date()

          const fg = theme?.foreground ?? "#ffffff"
          const muted = theme?.muted ?? "#888888"
          const red = theme?.red ?? "#ef4444"

          if (!existsSync(dbPath)) {
            api.ui.dialog.replace(() => {
              onMount(() => { api.ui.dialog.setSize("medium") })
              return (
                <box padding={2} flexDirection="column" gap={1}>
                  <text fg={red}><b>Usage Data Unavailable</b></text>
                  <text fg={muted}>Database not found at the expected location.</text>
                  <text fg={muted}>Please try again later.</text>
                </box>
              )
            })
            return
          }

          let minMonthOffset = 0
          let minWeekOffset = 0
          let minDayOffset = 0
          {
            const earliestMs = getEarliestUsageDate(dbPath)
            if (earliestMs != null) {
              const earliestDate = new Date(earliestMs)
              const earliestYear = earliestDate.getUTCFullYear()
              const earliestMonth = earliestDate.getUTCMonth()
              const currentYear = now.getUTCFullYear()
              const currentMonth = now.getUTCMonth()
              const monthsBack = (currentYear * 12 + currentMonth) - (earliestYear * 12 + earliestMonth)
              minMonthOffset = -monthsBack

              const earliestWeekMonday = getWeekMonday(earliestDate).getTime()
              const currentWeekMonday = getWeekMonday(new Date()).getTime()
              if (earliestWeekMonday < currentWeekMonday) {
                const diffWeeks = Math.floor((currentWeekMonday - earliestWeekMonday) / (7 * MS_PER_DAY))
                minWeekOffset = -diffWeeks
              }

              const earliestDayStart = Date.UTC(earliestDate.getUTCFullYear(), earliestDate.getUTCMonth(), earliestDate.getUTCDate())
              const currentDayStart = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())
              if (earliestDayStart < currentDayStart) {
                const diffDays = Math.floor((currentDayStart - earliestDayStart) / MS_PER_DAY)
                minDayOffset = -diffDays
              }
            }
          }

          const [granularity, setGranularity] = createSignal<Granularity>("month")
          const [monthOffset, setMonthOffset] = createSignal(0)
          const [weekOffset, setWeekOffset] = createSignal(0)
          const [dayOffset, setDayOffset] = createSignal(0)
          const scroll = makeScrollState(createSignal)

          const computeWindow = () => {
            if (granularity() === "month") {
              const m = now.getUTCMonth() + monthOffset()
              const y = now.getUTCFullYear() + Math.floor(m / 12)
              const month = ((m % 12) + 12) % 12
              const { startMs, endMs, label } = getMonthInfo(y, month)
              return { startMs, endMs, label }
            } else if (granularity() === "week") {
              const currentMonday = getWeekMonday(now)
              const targetMonday = new Date(currentMonday.getTime() + weekOffset() * 7 * MS_PER_DAY)
              const { startMs, endMs, label } = getWeekInfo(targetMonday)
              return { startMs, endMs, label }
            } else {
              const currentDayStart = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())
              const targetDayMs = currentDayStart + dayOffset() * MS_PER_DAY
              const startMs = targetDayMs
              const endMs = startMs + MS_PER_DAY
              const d = new Date(startMs)
              const label = d.toLocaleString("en-US", { weekday: "short", month: "short", day: "numeric", timeZone: "UTC" })
              return { startMs, endMs, label }
            }
          }

          const [viewState, setViewState] = createSignal<"loading" | "error" | UsageData>("loading")
          const [errorMsg, setErrorMsg] = createSignal<string>("")
          const [hasLoadedOnce, setHasLoadedOnce] = createSignal(false)
          const [diffInfo, setDiffInfo] = createSignal<{ arrow: string; text: string }>({ arrow: "\u2014", text: "\u2014" })

          const modelCache = new Map<string, UsageData>()

          function modelCacheKey(gran: Granularity, startMs: number): string {
            return `${gran}:${startMs}`
          }

          function computeAndSetDiff(startMs: number, currentTotal: number) {
            const gran = granularity()
            let previousTotal: number | null = null

            if (gran === "month") {
              const prevStartMs = getPrevMonthStartMs(startMs)
              const prevCached = getMonthCache(prevStartMs)
              if (prevCached) {
                previousTotal = prevCached.inputTokens + prevCached.outputTokens
              } else {
                const prevRows = fetchRawRows(dbPath, prevStartMs, startMs)
                if (!("error" in prevRows)) {
                  previousTotal = prevRows.reduce((s, r) => s + r.input_tokens + r.output_tokens, 0)
                }
              }
            } else {
              const periodMs = gran === "week" ? 7 * MS_PER_DAY : MS_PER_DAY
              const prevStartMs = startMs - periodMs
              const prevEndMs = startMs

              const currMonthStart = Date.UTC(new Date(startMs).getUTCFullYear(), new Date(startMs).getUTCMonth(), 1)
              const currCached = getMonthCache(currMonthStart)
              const periodField: "weeks" | "days" = gran === "week" ? "weeks" : "days"
              const currList = currCached?.[periodField]
              const prevPeriod = currList?.find((p: CachePeriod) => p.startMs === prevStartMs)
              if (prevPeriod) {
                previousTotal = prevPeriod.inputTokens + prevPeriod.outputTokens
              }

              if (previousTotal === null) {
                const prevMonthStart = Date.UTC(new Date(prevStartMs).getUTCFullYear(), new Date(prevStartMs).getUTCMonth(), 1)
                const prevCached = getMonthCache(prevMonthStart)
                const prevList = prevCached?.[periodField]
                const prevP = prevList?.find((p: CachePeriod) => p.startMs === prevStartMs)
                if (prevP) {
                  previousTotal = prevP.inputTokens + prevP.outputTokens
                }
              }

              if (previousTotal === null) {
                const prevRows = fetchRawRows(dbPath, prevStartMs, prevEndMs)
                if (!("error" in prevRows)) {
                  previousTotal = prevRows.reduce((s, r) => s + r.input_tokens + r.output_tokens, 0)
                }
              }
            }

            setDiffInfo(formatPercentDiff(currentTotal, previousTotal))
          }

          function loadData(forceRefresh: boolean = false) {
            const { startMs, endMs } = computeWindow()
            const gran = granularity()
            const cacheKey = modelCacheKey(gran, startMs)

            if (!forceRefresh) {
              const cachedModelData = modelCache.get(cacheKey)
              if (cachedModelData) {
                setViewState(cachedModelData)
                const currentTotal = cachedModelData.totalInput + cachedModelData.totalOutput
                computeAndSetDiff(startMs, currentTotal)
                if (!hasLoadedOnce()) setHasLoadedOnce(true)
                return
              }
            }

            if (gran === "month") {
              if (!forceRefresh) {
                const fileCached = getMonthCache(startMs)
                if (fileCached) {
                  const models = fileCached.models ?? []
                  const isCurrent = isCurrentMonth(startMs)
                  const isStale = isCurrent && (Date.now() - fileCached.lastUpdated) >= CACHE_TTL_MS
                  if (!isStale) {
                    const data: UsageData = {
                      models,
                      totalInput: fileCached.inputTokens,
                      totalOutput: fileCached.outputTokens,
                      totalCost: fileCached.totalCost,
                    }
                    setViewState(data)
                    modelCache.set(cacheKey, data)

                    const currentTotal = fileCached.inputTokens + fileCached.outputTokens
                    computeAndSetDiff(startMs, currentTotal)

                    if (!hasLoadedOnce()) setHasLoadedOnce(true)
                    return
                  }
                }
              }
            } else if (gran === "week" || gran === "day") {
              if (!forceRefresh) {
                const monthStart = Date.UTC(new Date(startMs).getUTCFullYear(), new Date(startMs).getUTCMonth(), 1)
                const monthCached = getMonthCache(monthStart)
                const periodList = gran === "week" ? monthCached?.weeks : monthCached?.days
                const period = periodList?.find(p => p.startMs === startMs)
                if (period) {
                  const models = period.models ?? []
                  const isCurrent = gran === "week" ? weekOffset() === 0 : dayOffset() === 0
                  const isStale = isCurrent && (Date.now() - period.lastUpdated) >= CACHE_TTL_MS
                  if (!isStale) {
                    const data: UsageData = {
                      models,
                      totalInput: period.inputTokens,
                      totalOutput: period.outputTokens,
                      totalCost: period.totalCost,
                    }
                    setViewState(data)
                    modelCache.set(cacheKey, data)

                    const currentTotal = period.inputTokens + period.outputTokens
                    computeAndSetDiff(startMs, currentTotal)

                    setTimeout(() => {
                      const periodMs = gran === "week" ? 7 * MS_PER_DAY : MS_PER_DAY
                      for (const adjStart of [startMs - periodMs, startMs + periodMs]) {
                        const adjKey = modelCacheKey(gran, adjStart)
                        if (modelCache.has(adjKey)) continue
                        let adjPeriod: CachePeriod | undefined
                        adjPeriod = periodList?.find(p => p.startMs === adjStart)
                        if (!adjPeriod) {
                          const adjMonthStart = Date.UTC(new Date(adjStart).getUTCFullYear(), new Date(adjStart).getUTCMonth(), 1)
                          const adjCached = getMonthCache(adjMonthStart)
                          const adjList2 = gran === "week" ? adjCached?.weeks : adjCached?.days
                          adjPeriod = adjList2?.find(p => p.startMs === adjStart)
                        }
                        if (adjPeriod) {
                          modelCache.set(adjKey, {
                            models: adjPeriod.models,
                            totalInput: adjPeriod.inputTokens,
                            totalOutput: adjPeriod.outputTokens,
                            totalCost: adjPeriod.totalCost,
                          })
                        }
                      }
                    }, 10)

                    if (!hasLoadedOnce()) setHasLoadedOnce(true)
                    return
                  }
                }
              }
            }

            setTimeout(() => {
              const rowsResult = fetchRawRows(dbPath, startMs, endMs)
              if ("error" in rowsResult) {
                setErrorMsg(rowsResult.error)
                setViewState("error")
                if (!hasLoadedOnce()) setHasLoadedOnce(true)
                return
              }

              const rows = rowsResult

              const usageData = computeUsageDataFromRows(rows)
              modelCache.set(modelCacheKey(granularity(), startMs), usageData)
              setViewState(usageData)

              if (granularity() === "month") {
                const monthStartMs = startMs
                const monthEndMs = endMs
                const period = buildHierarchy(rows, monthStartMs, monthEndMs)
                updateMonthCache(period)
              }

              computeAndSetDiff(startMs, usageData.totalInput + usageData.totalOutput)

              setTimeout(() => {
                if (gran === "month") {
                  for (const adjStartMs of [getPrevMonthStartMs(startMs), startMs + 32 * MS_PER_DAY]) {
                    const d = new Date(adjStartMs)
                    const adjNorm = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1)
                    const adjKey = modelCacheKey("month", adjNorm)
                    if (modelCache.has(adjKey)) continue
                    const adjEndMs = Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1)
                    const adjRows = fetchRawRows(dbPath, adjNorm, adjEndMs)
                    if ("error" in adjRows || adjRows.length === 0) continue
                    modelCache.set(adjKey, computeUsageDataFromRows(adjRows))
                  }
                } else {
                  const periodMs = gran === "week" ? 7 * MS_PER_DAY : MS_PER_DAY
                  for (const adjStart of [startMs - periodMs, startMs + periodMs]) {
                    const adjKey = modelCacheKey(gran, adjStart)
                    if (modelCache.has(adjKey)) continue
                    const adjRows = fetchRawRows(dbPath, adjStart, adjStart + periodMs)
                    if ("error" in adjRows || adjRows.length === 0) continue
                    const adjData = computeUsageDataFromRows(adjRows)
                    modelCache.set(adjKey, adjData)
                    const adjMonthStart = Date.UTC(new Date(adjStart).getUTCFullYear(), new Date(adjStart).getUTCMonth(), 1)
                    const adjMonth = getMonthCache(adjMonthStart)
                    if (adjMonth) {
                      const periodList = gran === "week" ? adjMonth.weeks : adjMonth.days
                      const period = periodList?.find(p => p.startMs === adjStart)
                      if (period) {
                        period.models = adjData.models
                        period.lastUpdated = Date.now()
                        saveDiskCache()
                      }
                    }
                  }
                }
              }, 50)

              if (!hasLoadedOnce()) setHasLoadedOnce(true)
            }, 0)
          }

          let cleanupKeyLayer: (() => void) | null = null

          function handleKey(key: string) {
            if (key === "left" || key === "h") {
              if (granularity() === "month") {
                if (monthOffset() <= minMonthOffset) return true
                setMonthOffset(p => p - 1)
              } else if (granularity() === "week") {
                if (weekOffset() <= minWeekOffset) return true
                setWeekOffset(p => p - 1)
              } else {
                if (dayOffset() <= minDayOffset) return true
                setDayOffset(p => p - 1)
              }
              scroll.scrollToTop()
              setTimeout(loadData, 0)
              return true
            }
            if (key === "right" || key === "l") {
              if (granularity() === "month") {
                if (monthOffset() >= 0) return true
                setMonthOffset(p => p + 1)
              } else if (granularity() === "week") {
                if (weekOffset() >= 0) return true
                setWeekOffset(p => p + 1)
              } else {
                if (dayOffset() >= 0) return true
                setDayOffset(p => p + 1)
              }
              scroll.scrollToTop()
              setTimeout(loadData, 0)
              return true
            }
            if (key === "r") {
              const { startMs } = computeWindow()
              const gran = granularity()
              const isCurrent = gran === "month"
                ? isCurrentMonth(startMs)
                : gran === "week"
                  ? weekOffset() === 0
                  : dayOffset() === 0
              if (isCurrent) {
                modelCache.delete(modelCacheKey(gran, startMs))
                loadData(true)
              }
              return true
            }
            if (key === "t") {
              if (granularity() === "month") {
                if (monthOffset() === 0) return true
                setMonthOffset(0)
              } else if (granularity() === "week") {
                if (weekOffset() === 0) return true
                setWeekOffset(0)
              } else {
                if (dayOffset() === 0) return true
                setDayOffset(0)
              }
              scroll.scrollToTop()
              setTimeout(loadData, 0)
              return true
            }
            if (key === "m") {
              if (granularity() === "month") {
                setGranularity("week")
                if (monthOffset() !== 0) {
                  const m = now.getUTCMonth() + monthOffset()
                  const y = now.getUTCFullYear() + Math.floor(m / 12)
                  const month = ((m % 12) + 12) % 12
                  const monthStart = Date.UTC(y, month, 1)
                  const targetMonday = getWeekMonday(new Date(monthStart + 7 * MS_PER_DAY)).getTime()
                  const currentMonday = getWeekMonday(new Date()).getTime()
                  const diffWeeks = Math.round((targetMonday - currentMonday) / (7 * MS_PER_DAY))
                  setWeekOffset(diffWeeks > 0 ? Math.min(diffWeeks, 0) : Math.max(diffWeeks, minWeekOffset))
                }
              } else if (granularity() === "week") {
                setGranularity("day")
                if (weekOffset() !== 0) {
                  const currentMonday = getWeekMonday(new Date())
                  const targetMonday = new Date(currentMonday.getTime() + weekOffset() * 7 * MS_PER_DAY + MS_PER_DAY)
                  const currentDayStart = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())
                  const targetDayStart = Date.UTC(targetMonday.getUTCFullYear(), targetMonday.getUTCMonth(), targetMonday.getUTCDate())
                  const diffDays = Math.round((targetDayStart - currentDayStart) / MS_PER_DAY)
                  setDayOffset(diffDays > 0 ? Math.min(diffDays, 0) : Math.max(diffDays, minDayOffset))
                }
              } else {
                setGranularity("month")
                if (dayOffset() !== 0) {
                  const currentDayStart = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())
                  const targetDayMs = currentDayStart + dayOffset() * MS_PER_DAY
                  const d = new Date(targetDayMs)
                  const currentYear = now.getUTCFullYear()
                  const currentMonth = now.getUTCMonth()
                  const newMonthOffset = (d.getUTCFullYear() * 12 + d.getUTCMonth()) - (currentYear * 12 + currentMonth)
                  setMonthOffset(newMonthOffset > 0 ? Math.min(newMonthOffset, 0) : Math.max(newMonthOffset, minMonthOffset))
                }
              }
              scroll.scrollToTop()
              setTimeout(loadData, 0)
              return true
            }
            if (key === "up") {
              return scroll.handleUp()
            }
            if (key === "down") {
              return scroll.handleDown()
            }
            return false
          }

          api.ui.dialog.replace(() => {
            const { label } = computeWindow()
            const gran = granularity()
            const offset = gran === "month" ? monthOffset() : gran === "week" ? weekOffset() : dayOffset()
            const minOffset = gran === "month" ? minMonthOffset : gran === "week" ? minWeekOffset : minDayOffset

            let arrows: string
            if (minOffset === 0) {
              arrows = ""
            } else if (offset >= 0) {
              arrows = " ←"
            } else if (offset <= minOffset) {
              arrows = " →"
            } else {
              arrows = " ← →"
            }

            onMount(() => {
              api.ui.dialog.setSize("large")
              cleanupKeyLayer = registerDialogKeyLayer(api, {
                bindings: [
                  { key: "left",  cmd: "usage.navLeft",  desc: "Previous" },
                  { key: "h",     cmd: "usage.navLeft",  desc: "Previous" },
                  { key: "right", cmd: "usage.navRight", desc: "Next" },
                  { key: "l",     cmd: "usage.navRight", desc: "Next" },
                  { key: "r",     cmd: "usage.reload",   desc: "Reload" },
                  { key: "t",     cmd: "usage.today",    desc: "Today" },
                  { key: "m",     cmd: "usage.toggleMode", desc: "Toggle mode" },
                  { key: "up",    cmd: "usage.scrollUp",   desc: "Scroll up" },
                  { key: "k",     cmd: "usage.scrollUp",   desc: "Scroll up" },
                  { key: "down",  cmd: "usage.scrollDown", desc: "Scroll down" },
                  { key: "j",     cmd: "usage.scrollDown", desc: "Scroll down" },
                ],
                commands: [
                  { name: "usage.navLeft",     title: "Previous",       run: async () => { handleKey("left") } },
                  { name: "usage.navRight",    title: "Next",           run: async () => { handleKey("right") } },
                  { name: "usage.reload",      title: "Reload Usage",   run: async () => { handleKey("r") } },
                  { name: "usage.today",       title: "Today",          run: async () => { handleKey("t") } },
                  { name: "usage.toggleMode",  title: "Toggle Mode",    run: async () => { handleKey("m") } },
                  { name: "usage.scrollUp",    title: "Scroll Up",      run: async () => { handleKey("up") } },
                  { name: "usage.scrollDown",  title: "Scroll Down",    run: async () => { handleKey("down") } },
                ],
              })
              loadData()
            })
            onCleanup(() => {
              if (cleanupKeyLayer) {
                try { cleanupKeyLayer() } catch { /* ignore */ }
                cleanupKeyLayer = null
              }
            })

            return (
              <box paddingLeft={2} paddingRight={2} paddingBottom={1} flexDirection="column" gap={1}>
                <box flexDirection="row" justifyContent="space-between">
                  <box flexDirection="row" gap={1}>
                    <text fg={fg}><b>Usage{gran === "week" ? " / weekly" : gran === "day" ? " / daily" : ""}</b></text>
                    <text fg={muted}>{gran === "week" ? `\u2014 ${label}` : label}{arrows}</text>
                  </box>
                  <text fg={muted}>esc</text>
                </box>
                {(() => {
                  const data = viewState()
                  const hasOverflow = data && typeof data === "object" && !("error" in data) && data.models.length > 5
                  return (
                    <text fg={muted}>{hasOverflow && scroll.isScrolled() ? "▲ more above" : " "}</text>
                  )
                })()}
                <scrollbox ref={(el) => scroll.scrollRef = el} flexDirection="column" gap={1} maxHeight={40} scrollbarOptions={{ visible: false }}>
                  {viewState() === "loading" ? (
                    <text fg={muted}>Loading usage data…</text>
                  ) : viewState() === "error" ? (
                    <box flexDirection="column" gap={1}>
                      <text fg={red}><b>Error Fetching Usage</b></text>
                      <text fg={muted}>{errorMsg()}</text>
                    </box>
                  ) : (
                    (() => {
                      const data = viewState() as UsageData
                      const { models, totalInput, totalOutput, totalCost } = data
                      const totalTokens = totalInput + totalOutput
                      const hasCost = totalCost > 0
                      const emptyResult = models.length === 0
                      return emptyResult ? (
                        <text fg={muted}>— No activity for {label}</text>
                      ) : (
                        <box paddingBottom={1}>
                          <text fg={fg}>Total: {fmt(totalTokens)} tokens{hasCost ? ` (${fmtCost(totalCost)})` : ""}{(() => {
                            const d = diffInfo()
                            if (d.text === "\u2014") return ""
                            return `  ${d.arrow} ${d.text}`
                          })()}</text>
                          <text fg={muted}>  ↑ Input:  {fmt(totalInput)} tokens</text>
                          <text fg={muted}>  ↓ Output: {fmt(totalOutput)} tokens</text>
                          <text> </text>
                          <text fg={fg}><b>Per Model</b> (top {models.length})</text>
                          <text> </text>
                          {models.map((m, i) => {
                            const modelTokens = m.totalInput + m.totalOutput
                            const pct = totalTokens > 0 ? (modelTokens / totalTokens) * 100 : 0
                            const displayName = `${m.providerID}/${m.modelID}`
                            const modelHasCost = m.totalCost > 0
                            return (
                              <box key={m.providerID + "/" + m.modelID} flexDirection="column" gap={1}>
                                <text fg={fg}>{i + 1}. {displayName}</text>
                                <text fg={muted}>{fmt(modelTokens)} tokens ({pct.toFixed(1)}%){modelHasCost ? ` \u2014 ${fmtCost(m.totalCost)}` : ""}</text>
                                <text fg={fg}>{buildBar(pct, 50)}</text>
                                {i < models.length - 1 && <text> </text>}
                              </box>
                            )
                          })}
                        </box>
                      )
                    })()
                  )}
                </scrollbox>
                {(() => {
                  const data = viewState()
                  const hasOverflow = data && typeof data === "object" && !("error" in data) && data.models.length > 5
                  return (
                    <text fg={muted}>{hasOverflow && !scroll.isAtBottom() ? "▼ more below" : " "}</text>
                  )
                })()}
                {hasLoadedOnce() && (
                  <text fg={muted}>
                    {gran === "month"
                      ? "t today  ·  ← → month  ·  m mode  ·  r reload  ·  ↑↓ scroll"
                      : gran === "week"
                        ? "t today  ·  ← → week  ·  m mode  ·  r reload  ·  ↑↓ scroll"
                        : "t today  ·  ← → day  ·  m mode  ·  r reload  ·  ↑↓ scroll"}
                  </text>
                )}
              </box>
            )
          })
        },
      },
    ],
    bindings: [
      {
        key: "ctrl+shift+u",
        cmd: "usage.show",
        desc: "Show Monthly Usage",
      },
    ],
  })
}
