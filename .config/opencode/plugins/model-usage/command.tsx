/** @jsxImportSource @opentui/solid */
import type { TuiPluginApi } from "@opencode-ai/plugin/tui"
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs"
import { homedir } from "node:os"

import { onMount, createSignal } from "solid-js"
import { getMonthInfo, isCurrentMonth, fmt, fmtCost, buildBar, randomReloadMessage } from "./helpers"
import type { UsageData } from "./types"
import { queryUsage } from "./db"

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

          // ── State ────────────────────────────────────────────────────────
          const [monthOffset, setMonthOffset] = createSignal(0)

          const computeMonth = () => {
            const m = now.getUTCMonth() + monthOffset()
            const y = now.getUTCFullYear() + Math.floor(m / 12)
            const month = ((m % 12) + 12) % 12
            const { startMs, endMs, label } = getMonthInfo(y, month)
            return { startMs, endMs, label }
          }

          const [viewState, setViewState] = createSignal<"loading" | "error" | UsageData>("loading")
          const [errorMsg, setErrorMsg] = createSignal<string>("")
          const [reloadMsg, setReloadMsg] = createSignal<string>("")
          const [reloading, setReloading] = createSignal(false)
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
                setReloading(false)
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
            if (forceRefresh) {
              setReloadMsg(`🔄 Reloading... ${randomReloadMessage()}`)
              setReloading(true)
            }

            setTimeout(() => {
              const result = queryUsage(dbPath, startMs, endMs)
              setCached(startMs, { result, month: startMs, cachedAt: Date.now() })
              setReloading(false)
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
              setMonthOffset(p => p - 1)
              setViewState("loading")
              setReloading(false)
              setTimeout(() => loadMonth(), 10)
              return true
            }
            if (key === "right" || key === "l") {
              setMonthOffset(p => p + 1)
              if (monthOffset() + 1 > 0) return true  // don't go past current
              setViewState("loading")
              setReloading(false)
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
            return false
          }

          // ── Reactive dialog ─────────────────────────────────────────────
          api.ui.dialog.replace(() => {
            const { label } = computeMonth()
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
                ],
                commands: [
                  { name: "usage.navLeft",  title: "Previous Month", async run() { handleKey("left") } },
                  { name: "usage.navRight", title: "Next Month",     async run() { handleKey("right") } },
                  { name: "usage.reload",   title: "Reload Usage",   async run() { handleKey("r") } },
                ],
              })
              // Initial load
              loadMonth()
            })

            return (
              <box paddingLeft={2} paddingRight={2} paddingBottom={1} flexDirection="column" gap={1}>
                <box flexDirection="row" justifyContent="space-between">
                  <box flexDirection="row" gap={1}>
                    <text fg={fg}><b>Usage</b></text>
                    <text fg={muted}>{label} ← →</text>
                  </box>
                  <text fg={muted}>esc</text>
                </box>
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
                        <text> </text>
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
                {reloading() && <text fg={muted}>{reloadMsg()}</text>}
                {hasLoadedOnce() && (
                  <text fg={muted}>← → month  ·  r reload</text>
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
