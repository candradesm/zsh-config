import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs"
import { homedir } from "node:os"
import type { ModelUsage } from "./types"

// ─── Constants ───────────────────────────────────────────────────────────────

export const MS_PER_DAY = 86_400_000
export const CACHE_TTL_MS = 60_000
export const CACHE_VERSION = 3
export const PREFETCH_DELAY_MS = 100

// ─── Types ───────────────────────────────────────────────────────────────────

export interface CachePeriod {
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

export interface UsageCache {
  version: number
  months: Record<string, CachePeriod>
}

// ─── Module-private state ────────────────────────────────────────────────────

const CACHE_DIR = `${homedir()}/.config/opencode/plugins/model-usage`
const CACHE_FILE = `${CACHE_DIR}/.usage-cache.json`

let usageCache: UsageCache = { version: CACHE_VERSION, months: {} }

let saveTimer: ReturnType<typeof setTimeout> | null = null
const SAVE_DEBOUNCE_MS = 2000

// ─── Private helpers ─────────────────────────────────────────────────────────

function ensureCacheDir() {
  try { mkdirSync(CACHE_DIR, { recursive: true }) } catch { /* ignore */ }
}

function loadDiskCache() {
  ensureCacheDir()
  try {
    if (existsSync(CACHE_FILE)) {
      const raw = readFileSync(CACHE_FILE, "utf-8")
      const data = JSON.parse(raw)
      if (data.version === CACHE_VERSION && data.months) {
        usageCache = data as UsageCache
      } else if (data.version === 2 && data.months) {
        usageCache = migrateV2Cache(data)
        saveDiskCache() // persist migration immediately
      }
      // else: unknown version — start fresh
    }
  } catch { /* ignore */ }
}

function saveDiskCache() {
  ensureCacheDir()
  try {
    writeFileSync(CACHE_FILE, JSON.stringify(usageCache, null, 2))
  } catch { /* ignore */ }
}

// ─── Public functions ────────────────────────────────────────────────────────

export function migrateV2Cache(data: any): UsageCache {
  const cloned = JSON.parse(JSON.stringify(data))
  const months = cloned.months || {}
  for (const key of Object.keys(months)) {
    const month = months[key]
    if (!month) continue

    function normalizeModels(models: any[] | null | undefined) {
      if (!models) return
      for (const m of models) {
        if (m.providerId !== undefined && m.providerID === undefined) {
          m.providerID = m.providerId
          delete m.providerId
        }
        if (m.modelId !== undefined && m.modelID === undefined) {
          m.modelID = m.modelId
          delete m.modelId
        }
      }
    }

    normalizeModels(month.models)
    if (month.weeks) {
      for (const w of month.weeks) {
        normalizeModels(w.models)
        if (w.days) {
          for (const d of w.days) {
            normalizeModels(d.models)
          }
        }
      }
    }
    if (month.days) {
      for (const d of month.days) {
        normalizeModels(d.models)
      }
    }
  }
  return { version: CACHE_VERSION, months }
}

export function getMonthCache(startMs: number): CachePeriod | undefined {
  return usageCache.months[String(startMs)]
}

export function getPrevMonthStartMs(ms: number): number {
  const d = new Date(ms)
  let m = d.getUTCMonth() - 1
  let y = d.getUTCFullYear()
  if (m < 0) { m = 11; y-- }
  return Date.UTC(y, m, 1)
}

export function updateMonthCache(period: CachePeriod) {
  const key = String(period.startMs)

  const prevMonthStartMs = getPrevMonthStartMs(period.startMs)
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

  const prevDate = new Date(period.startMs)
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

  scheduleDiskSave()
}

export function scheduleDiskSave() {
  if (saveTimer !== null) return
  saveTimer = setTimeout(() => {
    saveTimer = null
    saveDiskCache()
  }, SAVE_DEBOUNCE_MS)
}

export function flushDiskSave() {
  if (saveTimer !== null) {
    clearTimeout(saveTimer)
    saveTimer = null
    saveDiskCache()
  }
}

// ─── Module init ─────────────────────────────────────────────────────────────

loadDiskCache()
