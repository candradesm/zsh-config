/** @jsxImportSource @opentui/solid */
import type { TuiPluginApi } from "@opencode-ai/plugin/tui"
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs"
import { homedir } from "node:os"

import { onMount, onCleanup, createSignal } from "solid-js"
import { getMonthInfo, isCurrentMonth, fmt, fmtCost, buildBar } from "./helpers"
import type { UsageData } from "./types"
import { queryUsage, getEarliestUsageDate } from "./db"

// ─── Persistent multi-month cache ─────────────────────────────────────────
const CACHE_DIR = `${homedir()}/.config/opencode/plugins/model-usage`
const CACHE_FILE = `${CACHE_DIR}/.usage-cache.json`
const CACHE_TTL_MS = 60_000

interface CacheEntry {
  result: UsageData | { error: string }
  month: number  // startMs
  cachedAt: number
}

let memoryCache = new Map<number, CacheEntry>()

function ensureCacheDir() {
  try { mkdirSync(CACHE_DIR, { recursive: true }) } catch { /* ignore */ }
}

function loadDiskCache() {
  ensureCacheDir()
  try {
    if (existsSync(CACHE_FILE)) {
      const raw = readFileSync(CACHE_FILE, "utf-8")
      const data = JSON.parse(raw)
      if (data.months) {
        for (const [key, val] of Object.entries(data.months)) {
          memoryCache.set(Number(key), val as CacheEntry)
        }
      }
    }
  } catch { /* ignore */ }
}

function saveDiskCache() {
  ensureCacheDir()
  try {
    const obj: Record<string, CacheEntry> = {}
    for (const [key, val] of memoryCache.entries()) {
      obj[String(key)] = val
    }
    writeFileSync(CACHE_FILE, JSON.stringify({ months: obj }, null, 2))
  } catch { /* ignore */ }
}

function getCached(month: number): CacheEntry | undefined {
  return memoryCache.get(month)
}

function setCached(month: number, entry: CacheEntry) {
  memoryCache.set(month, entry)
  saveDiskCache()
}

// Load on module init
loadDiskCache()

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
          const currentMonthStart = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)

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

          // ── Determine earliest month with data ──────────────────────────
          let minMonthOffset = 0
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
            }
          }

          // ── State ────────────────────────────────────────────────────────
          const [monthOffset, setMonthOffset] = createSignal(0)
          let scrollRef: any = null
          const [isScrolled, setIsScrolled] = createSignal(false)
          const [isAtBottom, setIsAtBottom] = createSignal(false)

          const computeMonth = () => {
            const m = now.getUTCMonth() + monthOffset()
            const y = now.getUTCFullYear() + Math.floor(m / 12)
            const month = ((m % 12) + 12) % 12
            const { startMs, endMs, label } = getMonthInfo(y, month)
            return { startMs, endMs, label }
          }

          const [viewState, setViewState] = createSignal<"loading" | "error" | UsageData>("loading")
          const [errorMsg, setErrorMsg] = createSignal<string>("")
          const [hasLoadedOnce, setHasLoadedOnce] = createSignal(false)

          function loadMonth(forceRefresh: boolean = false) {
            const { startMs, endMs } = computeMonth()
            const isCurrent = isCurrentMonth(startMs)

            // Past month: use cache always, no refresh
            if (!isCurrent) {
              const cached = getCached(startMs)
              if (cached) {
                const data = cached.result
                if ("error" in data) {
                  setErrorMsg(data.error)
                  setViewState("error")
                } else {
                  setViewState(data)
                }
                if (!hasLoadedOnce()) setHasLoadedOnce(true)
                return
              }
            }

            // Current month: check cache freshness unless forced refresh
            if (!forceRefresh) {
              const cached = getCached(startMs)
              if (cached && (Date.now() - cached.cachedAt) < CACHE_TTL_MS) {
                const data = cached.result
                if ("error" in data) {
                  setErrorMsg(data.error)
                  setViewState("error")
                } else {
                  setViewState(data)
                }
                if (!hasLoadedOnce()) setHasLoadedOnce(true)
                return
              }
            }

            // Show stale cache as placeholder if available
            if (!forceRefresh) {
              const cached = getCached(startMs)
              if (cached && !("error" in cached.result)) {
                setViewState(cached.result as UsageData)
              }
            }

            // Background query
            setTimeout(() => {
              const result = queryUsage(dbPath, startMs, endMs)
              setCached(startMs, { result, month: startMs, cachedAt: Date.now() })
              if ("error" in result) {
                setErrorMsg(result.error)
                setViewState("error")
              } else {
                setViewState(result)
              }
              if (!hasLoadedOnce()) setHasLoadedOnce(true)
            }, 10)
          }

          // ── Handle key presses ──────────────────────────────────────────
          let dialogKeyLayer: any = null

          function handleKey(key: string) {
            if (key === "left" || key === "h") {
              if (monthOffset() <= minMonthOffset) return true  // hard cap: no older months available
              setMonthOffset(p => p - 1)
              setIsScrolled(false)
              setIsAtBottom(false)
              setTimeout(() => loadMonth(), 10)
              return true
            }
            if (key === "right" || key === "l") {
              if (monthOffset() >= 0) return true  // already at current month, don't go past
              setMonthOffset(p => p + 1)
              setIsScrolled(false)
              setIsAtBottom(false)
              setTimeout(() => loadMonth(), 10)
              return true
            }
            if (key === "r") {
              const { startMs } = computeMonth()
              if (isCurrentMonth(startMs)) {
                loadMonth(true)
              }
              return true
            }
            if (key === "t") {
              if (monthOffset() === 0) return true  // already at current month
              setMonthOffset(0)
              setIsScrolled(false)
              setIsAtBottom(false)
              setTimeout(() => loadMonth(), 10)
              return true
            }
            if (key === "up") {
              scrollRef?.scrollBy?.(-10)
              setIsAtBottom(false)
              setTimeout(() => {
                const top = scrollRef?.scrollTop ?? 0
                if (top <= 0) setIsScrolled(false)
              }, 50)
              return true
            }
            if (key === "down") {
              scrollRef?.scrollBy?.(10)
              setIsScrolled(true)
              setTimeout(() => {
                const st = scrollRef?.scrollTop ?? 0
                const ch = scrollRef?.clientHeight ?? scrollRef?.height ?? 40
                const sh = scrollRef?.scrollHeight ?? 0
                setIsAtBottom(st + ch >= sh - 5)
              }, 50)
              return true
            }
            return false
          }

          // ── Reactive dialog ─────────────────────────────────────────────
          api.ui.dialog.replace(() => {
            const { label } = computeMonth()
            const offset = monthOffset()
            let arrows: string
            if (minMonthOffset === 0) {
              arrows = ""                    // Case 4: only month available
            } else if (offset >= 0) {
              arrows = " ←"                  // Case 1: at current month, can only go older
            } else if (offset <= minMonthOffset) {
              arrows = " →"                  // Case 3: at oldest month, can only go newer
            } else {
              arrows = " ← →"                // Case 2: middle month, both directions
            }
            onMount(() => {
              api.ui.dialog.setSize("large")
              // Register dialog key layer
              dialogKeyLayer = api.keymap.registerLayer({
                bindings: [
                  { key: "left",  cmd: "usage.navLeft",  desc: "Previous month" },
                  { key: "h",     cmd: "usage.navLeft",  desc: "Previous month" },
                  { key: "right", cmd: "usage.navRight", desc: "Next month" },
                  { key: "l",     cmd: "usage.navRight", desc: "Next month" },
                  { key: "r",     cmd: "usage.reload",   desc: "Reload" },
                  { key: "t",     cmd: "usage.today",   desc: "Today" },
                  { key: "up",   cmd: "usage.scrollUp",   desc: "Scroll up" },
                  { key: "k",    cmd: "usage.scrollUp",   desc: "Scroll up" },
                  { key: "down", cmd: "usage.scrollDown", desc: "Scroll down" },
                  { key: "j",    cmd: "usage.scrollDown", desc: "Scroll down" },
                ],
                commands: [
                  { name: "usage.navLeft",   title: "Previous Month", async run() { handleKey("left") } },
                  { name: "usage.navRight",  title: "Next Month",     async run() { handleKey("right") } },
                  { name: "usage.reload",    title: "Reload Usage",   async run() { handleKey("r") } },
                  { name: "usage.today",    title: "Today",        async run() { handleKey("t") } },
                  { name: "usage.scrollUp",   title: "Scroll Up",   async run() { handleKey("up") } },
                  { name: "usage.scrollDown", title: "Scroll Down", async run() { handleKey("down") } },
                ],
              })
              // Initial load
              loadMonth()
              // Background: prefetch past months so navigation is instant
              setTimeout(() => {
                // Compute earliest month timestamp from the data cap
                const minMonthYear = now.getUTCFullYear() + Math.floor((now.getUTCMonth() + minMonthOffset) / 12)
                const minMonthMonth = ((now.getUTCMonth() + minMonthOffset) % 12 + 12) % 12
                const minPrefetchMs = Date.UTC(minMonthYear, minMonthMonth, 1)

                let m = now.getUTCMonth() - 1
                let y = now.getUTCFullYear()
                while (true) {
                  if (m < 0) { m = 11; y-- }
                  const startMs = Date.UTC(y, m, 1)
                  if (startMs < minPrefetchMs) break
                  if (getCached(startMs)) { m--; continue }
                  const endMs = Date.UTC(y, m + 1, 1)
                  const result = queryUsage(dbPath, startMs, endMs)
                  setCached(startMs, { result, month: startMs, cachedAt: Date.now() })
                  // Stop if no data this far back
                  if (!("error" in result) && result.models.length === 0) break
                  m--
                }
              }, 500)
            })
            onCleanup(() => {
              if (dialogKeyLayer) {
                try { dialogKeyLayer() } catch { /* ignore */ }
                dialogKeyLayer = null
              }
            })

            return (
              <box paddingLeft={2} paddingRight={2} paddingBottom={1} flexDirection="column" gap={1}>
                <box flexDirection="row" justifyContent="space-between">
                  <box flexDirection="row" gap={1}>
                    <text fg={fg}><b>Usage</b></text>
                    <text fg={muted}>{label}{arrows}</text>
                  </box>
                  <text fg={muted}>esc</text>
                </box>
                {(() => {
                  const data = viewState()
                  const hasOverflow = data && typeof data === "object" && !("error" in data) && data.models.length > 5
                  return (
                    <text fg={muted}>{hasOverflow && isScrolled() ? "▲ more above" : " "}</text>
                  )
                })()}
                <scrollbox ref={scrollRef} flexDirection="column" gap={1} maxHeight={40} scrollbarOptions={{ visible: false }}>
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
                        <text fg={muted}>No usage data for {label}.</text>
                      ) : (
                        <box paddingBottom={1}>
                          <text fg={fg}>Total: {fmt(totalTokens)} tokens{hasCost ? ` (${fmtCost(totalCost)})` : ""}</text>
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
                                <text fg={muted}>{fmt(modelTokens)} tokens ({pct.toFixed(1)}%){modelHasCost ? ` — ${fmtCost(m.totalCost)}` : ""}</text>
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
                    <text fg={muted}>{hasOverflow && !isAtBottom() ? "▼ more below" : " "}</text>
                  )
                })()}
                {hasLoadedOnce() && (
                  <text fg={muted}>t today  ·  ← → month  ·  r reload  ·  ↑↓ scroll</text>
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
