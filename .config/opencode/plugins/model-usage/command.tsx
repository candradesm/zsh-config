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
const CACHE_TTL_MS = 60_000  // 60 seconds — current period cache is stale after this

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
      // else: old format (version 1 or missing) — start fresh
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

/** Aggregate raw rows into UsageData (per-model breakdown). */
function computeUsageDataFromRows(rows: RawUsageRow[]): UsageData {
  const modelMap = new Map<string, ModelUsage>()

  for (const row of rows) {
    if (!row.provider_id || !row.model_id) continue
    const key = `${row.provider_id}/${row.model_id}`
    let existing = modelMap.get(key)
    if (!existing) {
      existing = { providerId: row.provider_id, modelId: row.model_id, totalCost: 0, totalInput: 0, totalOutput: 0 }
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

/** Build hierarchical cache tree from raw rows for a given month. */
function buildHierarchy(rows: RawUsageRow[], monthStartMs: number, monthEndMs: number): CachePeriod {
  // Bucket rows by day
  const dayMap = new Map<number, CachePeriod>()
  const dayModels = new Map<number, Map<string, { providerId: string; modelId: string; totalCost: number; totalInput: number; totalOutput: number }>>()
  const weekModels = new Map<number, Map<string, { providerId: string; modelId: string; totalCost: number; totalInput: number; totalOutput: number }>>()
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

    // Accumulate per-model breakdown during the initial pass
    if (row.provider_id && row.model_id) {
      let dm = dayModels.get(dayMs)
      if (!dm) {
        dm = new Map()
        dayModels.set(dayMs, dm)
      }
      const mk = `${row.provider_id}/${row.model_id}`
      let me = dm.get(mk)
      if (!me) {
        me = { providerId: row.provider_id, modelId: row.model_id, totalCost: 0, totalInput: 0, totalOutput: 0 }
        dm.set(mk, me)
      }
      me.totalCost += Math.max(0, row.cost ?? 0)
      me.totalInput += Math.max(0, row.input_tokens ?? 0)
      me.totalOutput += Math.max(0, row.output_tokens ?? 0)
    }

    // Accumulate per-model breakdown for weeks during the initial pass
    if (row.provider_id && row.model_id) {
      const wm = getWeekMonday(new Date(row.time_created)).getTime()
      let wmap = weekModels.get(wm)
      if (!wmap) { wmap = new Map(); weekModels.set(wm, wmap) }
      const mk = `${row.provider_id}/${row.model_id}`
      let me = wmap.get(mk)
      if (!me) { me = { providerId: row.provider_id, modelId: row.model_id, totalCost: 0, totalInput: 0, totalOutput: 0 }; wmap.set(mk, me) }
      me.totalCost += Math.max(0, row.cost ?? 0)
      me.totalInput += Math.max(0, row.input_tokens ?? 0)
      me.totalOutput += Math.max(0, row.output_tokens ?? 0)
    }
  }

  // Fill in ALL days in the month range (including empty ones) so navigating
  // to any day within a cached month is instant — no DB query for empty days.
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

  // Compute per-model breakdown for each day from accumulated data
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

  // Group days into ISO weeks
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

    // Change vs previous week (within this month's weeks)
    let change: number | null = null
    if (i > 0) {
      const prev = weekMap.get(sortedWeekKeys[i - 1])!
      const prevTotal = prev.days.reduce((s, d) => s + d.inputTokens + d.outputTokens, 0)
      const currTotal = inputTokens + outputTokens
      if (prevTotal > 0) {
        change = Math.round(((currTotal - prevTotal) / prevTotal) * 100)
      }
    }

    // Compute per-model breakdown for this week from accumulated data
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

  // Compute per-model breakdown for this month and store in cache
  const monthModels = computeUsageDataFromRows(rows).models

  return {
    startMs: monthStartMs,
    endMs: monthEndMs,
    inputTokens: totalInput,
    outputTokens: totalOutput,
    totalCost: totalCostW,
    change: null, // filled in by updateMonthCache
    lastUpdated: Date.now(),
    weeks,
    days: sortedDays,
    models: monthModels,
  }
}

/** Store a month entry in the cache, computing change vs adjacent months. */
function updateMonthCache(period: CachePeriod) {
  const key = String(period.startMs)

  // Compute change vs previous month
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

  // Update first week's change vs last week of previous month
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

  // Also update next month's change if it exists
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

/** Get the previous month's startMs given a month timestamp. */
function getPrevMonthStartMs(ms: number): number {
  const d = new Date(ms)
  let m = d.getUTCMonth() - 1
  let y = d.getUTCFullYear()
  if (m < 0) { m = 11; y-- }
  return Date.UTC(y, m, 1)
}

/** Get the month and year that contains a given timestamp. */
function getMonthFromMs(ms: number): { year: number; month: number } {
  const d = new Date(ms)
  return { year: d.getUTCFullYear(), month: d.getUTCMonth() }
}

/** Get the first Monday that falls within a given month. */
function getFirstMondayInMonth(year: number, month: number): number {
  const monthStartMs = Date.UTC(year, month, 1)
  const d = new Date(monthStartMs)
  const day = d.getUTCDay() // 0=Sun, 1=Mon, ..., 6=Sat
  const daysUntilMonday = (8 - day) % 7
  return monthStartMs + daysUntilMonday * MS_PER_DAY
}

// ─── Command registration ──────────────────────────────────────────────────

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

          // ── DB not found ────────────────────────────────────────────────
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

          // ── Determine earliest data bounds ──────────────────────────────
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

              // Week offset
              const earliestWeekMonday = getWeekMonday(earliestDate).getTime()
              const currentWeekMonday = getWeekMonday(new Date()).getTime()
              if (earliestWeekMonday < currentWeekMonday) {
                const diffWeeks = Math.floor((currentWeekMonday - earliestWeekMonday) / (7 * MS_PER_DAY))
                minWeekOffset = -diffWeeks
              }

              // Day offset
              const earliestDayStart = Date.UTC(earliestDate.getUTCFullYear(), earliestDate.getUTCMonth(), earliestDate.getUTCDate())
              const currentDayStart = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())
              if (earliestDayStart < currentDayStart) {
                const diffDays = Math.floor((currentDayStart - earliestDayStart) / MS_PER_DAY)
                minDayOffset = -diffDays
              }
            }
          }

          // ── State ────────────────────────────────────────────────────────
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
              // day mode
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

          // In-memory per-model cache for instant navigation
          // Keyed by "{granularity}:{startMs}" — dies with the dialog
          const modelCache = new Map<string, UsageData>()

          function modelCacheKey(gran: Granularity, startMs: number): string {
            return `${gran}:${startMs}`
          }

          // ── Data loading ────────────────────────────────────────────────

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

              // Check current month cache
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

            // Check in-memory cache first
            if (!forceRefresh) {
              const cachedModelData = modelCache.get(cacheKey)
              if (cachedModelData) {
                setViewState(cachedModelData)
                const currentTotal = cachedModelData.totalInput + cachedModelData.totalOutput
                computeAndSetDiff(startMs, currentTotal)
                if (!hasLoadedOnce()) setHasLoadedOnce(true)
                return  // Instant — no DB query needed
              }
            }

            // Check file cache for stored model breakdown (all granularities)
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
                // For week/day: look up the parent month cache, then find the specific week/day
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

                    // Background prefetch of adjacent periods from file cache
                    setTimeout(() => {
                      const periodMs = gran === "week" ? 7 * MS_PER_DAY : MS_PER_DAY
                      for (const adjStart of [startMs - periodMs, startMs + periodMs]) {
                        const adjKey = modelCacheKey(gran, adjStart)
                        if (modelCache.has(adjKey)) continue
                        // Try current month's cache first, then adjacent month
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

            // Background fetch
            setTimeout(() => {
              const rowsResult = fetchRawRows(dbPath, startMs, endMs)
              if ("error" in rowsResult) {
                setErrorMsg(rowsResult.error)
                setViewState("error")
                if (!hasLoadedOnce()) setHasLoadedOnce(true)
                return
              }

              const rows = rowsResult

              // Compute per-model breakdown for UI
              const usageData = computeUsageDataFromRows(rows)
              modelCache.set(modelCacheKey(granularity(), startMs), usageData)
              setViewState(usageData)

              // For month mode: build hierarchical cache
              if (granularity() === "month") {
                const monthStartMs = startMs
                const monthEndMs = endMs
                const period = buildHierarchy(rows, monthStartMs, monthEndMs)
                updateMonthCache(period)
              }

              computeAndSetDiff(startMs, usageData.totalInput + usageData.totalOutput)

              // Background prefetch: cache adjacent periods for instant navigation
              setTimeout(() => {
                if (gran === "month") {
                  // Prefetch previous and next month
                  for (const adjStartMs of [getPrevMonthStartMs(startMs), startMs + 32 * MS_PER_DAY]) {
                    // normalize next month start
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
                  // Prefetch previous and next period (week or day)
                  const periodMs = gran === "week" ? 7 * MS_PER_DAY : MS_PER_DAY
                  for (const adjStart of [startMs - periodMs, startMs + periodMs]) {
                    const adjKey = modelCacheKey(gran, adjStart)
                    if (modelCache.has(adjKey)) continue
                    const adjRows = fetchRawRows(dbPath, adjStart, adjStart + periodMs)
                    if ("error" in adjRows || adjRows.length === 0) continue
                    const adjData = computeUsageDataFromRows(adjRows)
                    modelCache.set(adjKey, adjData)
                    // Also persist to file cache
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

          // ── Handle key presses ──────────────────────────────────────────
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
                // Month → Week
                let newWeekOffset = 0
                if (monthOffset() !== 0) {
                  const m = now.getUTCMonth() + monthOffset()
                  const y = now.getUTCFullYear() + Math.floor(m / 12)
                  const month = ((m % 12) + 12) % 12
                  const firstMondayMs = getFirstMondayInMonth(y, month)
                  const currentWeekMonday = getWeekMonday(now).getTime()
                  const diffWeeks = Math.round((currentWeekMonday - firstMondayMs) / (7 * MS_PER_DAY))
                  newWeekOffset = -diffWeeks
                }
                setGranularity("week")
                setWeekOffset(newWeekOffset)
              } else if (granularity() === "week") {
                // Week → Day
                let newDayOffset = 0
                if (weekOffset() !== 0) {
                  const currentMonday = getWeekMonday(now)
                  const targetMonday = new Date(currentMonday.getTime() + weekOffset() * 7 * MS_PER_DAY)
                  const currentDayStart = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())
                  const targetDayStart = Date.UTC(targetMonday.getUTCFullYear(), targetMonday.getUTCMonth(), targetMonday.getUTCDate())
                  const diffDays = Math.round((targetDayStart - currentDayStart) / MS_PER_DAY)
                  newDayOffset = diffDays
                }
                setGranularity("day")
                setDayOffset(newDayOffset)
              } else {
                // Day → Month
                let newMonthOffset = 0
                if (dayOffset() !== 0) {
                  const currentDayStart = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())
                  const targetDayMs = currentDayStart + dayOffset() * MS_PER_DAY
                  const d = new Date(targetDayMs)
                  const currentYear = now.getUTCFullYear()
                  const currentMonth = now.getUTCMonth()
                  newMonthOffset = (d.getUTCFullYear() * 12 + d.getUTCMonth()) - (currentYear * 12 + currentMonth)
                }
                setGranularity("month")
                setMonthOffset(newMonthOffset)
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

          // ── Reactive dialog ─────────────────────────────────────────────
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
              // Initial load
              loadData()
              // Background: prefetch past months so navigation is instant
              setTimeout(() => {
                const minMonthYear = now.getUTCFullYear() + Math.floor((now.getUTCMonth() + minMonthOffset) / 12)
                const minMonthMonth = ((now.getUTCMonth() + minMonthOffset) % 12 + 12) % 12
                const minPrefetchMs = Date.UTC(minMonthYear, minMonthMonth, 1)

                let m = now.getUTCMonth() - 1
                let y = now.getUTCFullYear()
                while (true) {
                  if (m < 0) { m = 11; y-- }
                  const startMs = Date.UTC(y, m, 1)
                  if (startMs < minPrefetchMs) break
                  const endMs = Date.UTC(y, m + 1, 1)

                  // Skip if already cached with complete data
                  const existing = getMonthCache(startMs)
                  if (existing && existing.lastUpdated >= endMs) { m--; continue }

                  const rowsResult = fetchRawRows(dbPath, startMs, endMs)
                  if ("error" in rowsResult) { m--; continue }

                  const period = buildHierarchy(rowsResult, startMs, endMs)
                  updateMonthCache(period)

                  // Stop if no data this far back
                  if (period.inputTokens === 0 && period.outputTokens === 0) break
                  m--
                }
              }, 500)
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
                            const displayName = `${m.providerId}/${m.modelId}`
                            const modelHasCost = m.totalCost > 0
                            return (
                              <box key={m.providerId + "/" + m.modelId} flexDirection="column" gap={1}>
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
