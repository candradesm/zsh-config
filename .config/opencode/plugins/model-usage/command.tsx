/** @jsxImportSource @opentui/solid */
import type { TuiPluginApi } from "@opencode-ai/plugin/tui"
import { existsSync } from "node:fs"
import { homedir } from "node:os"
import { onMount, createSignal } from "solid-js"
import { getMonthInfo, fmt, fmtCost, buildBar } from "./helpers"
import type { UsageData } from "./types"
import { queryUsage } from "./db"

const CACHE_TTL_MS = 60_000 // 1 minute

let cachedResult: UsageData | { error: string } | null = null
let cachedMonth: number = -1
let cachedAt: number = 0

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
          const { startMs, endMs, label } = getMonthInfo()
          const theme = api.theme.current
          const dbPath = `${homedir()}/.local/share/opencode/opencode.db`

          const fg = theme?.foreground ?? "#ffffff"
          const muted = theme?.muted ?? "#888888"
          const red = theme?.red ?? "#ef4444"

          // ── DB not found ────────────────────────────────────────────────
          if (!existsSync(dbPath)) {
            api.ui.dialog.replace(() => {
              onMount(() => {
                api.ui.dialog.setSize("medium")
              })
              return (
                <box padding={2} flexDirection="column" gap={1}>
                  <text fg={red}>
                    <b>Usage Data Unavailable</b>
                  </text>
                  <text fg={muted}>
                    Database not found at the expected location.
                  </text>
                  <text fg={muted}>Please try again later.</text>
                </box>
              )
            })
            return
          }

          // ── Reactive dialog: show instantly, query in background ────────
          const [viewState, setViewState] = createSignal<"loading" | "error" | UsageData>("loading")
          const [errorMsg, setErrorMsg] = createSignal<string>("")

          api.ui.dialog.replace(() => {
            onMount(() => {
              api.ui.dialog.setSize("large")
            })
            return (
              <box paddingLeft={2} paddingRight={2} paddingBottom={1} flexDirection="column" gap={1}>
                <box flexDirection="row" justifyContent="space-between">
                  <box flexDirection="column" gap={0}>
                    <text fg={fg}><b>This Month Usage</b></text>
                    <text fg={muted}>{label}</text>
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
              </box>
            )
          })

          // Use cache if fresh and same month, otherwise query in background
          const cacheIsFresh = cachedResult && cachedMonth === startMs && (Date.now() - cachedAt) < CACHE_TTL_MS
          if (cacheIsFresh) {
            const cached = cachedResult!
            if ("error" in cached) {
              setErrorMsg(cached.error)
              setViewState("error")
            } else {
              setViewState(cached)
            }
          } else {
            // Show cached data as placeholder if available (instant), then refresh
            if (cachedResult && cachedMonth === startMs && !("error" in cachedResult)) {
              setViewState(cachedResult)
            }
            setTimeout(() => {
              const result = queryUsage(dbPath, startMs, endMs)
              cachedResult = result
              cachedMonth = startMs
              cachedAt = Date.now()
              if ("error" in result) {
                setErrorMsg(result.error)
                setViewState("error")
              } else {
                setViewState(result)
              }
            }, 10)
          }
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
