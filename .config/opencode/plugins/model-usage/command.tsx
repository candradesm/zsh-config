/** @jsxImportSource @opentui/solid */
import type { TuiPluginApi } from "@opencode-ai/plugin/tui"
import { existsSync } from "node:fs"
import { homedir } from "node:os"
import { onMount } from "solid-js"
import { getMonthInfo, fmt, fmtCost, buildBar, barColor } from "./helpers"
import { queryUsage } from "./db"

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

          // ── Loading ──────────────────────────────────────────────────────
          api.ui.dialog.replace(() => {
            onMount(() => {
              api.ui.dialog.setSize("large")
            })
            return (
              <box paddingLeft={2} paddingRight={2} paddingBottom={1} flexDirection="column" gap={1}>
                <text fg={fg}>
                  <b>Loading usage data…</b>
                </text>
              </box>
            )
          })

          // ── Yield to let the TUI paint the loading dialog ───────────────
          await new Promise(r => setTimeout(r, 0))

          // ── Query ────────────────────────────────────────────────────────
          const result = queryUsage(dbPath, startMs, endMs)

          // ── Query error ──────────────────────────────────────────────────
          if ("error" in result) {
            api.ui.dialog.replace(() => (
              <box padding={2} flexDirection="column" gap={1}>
                <text fg={red}>
                  <b>Error Fetching Usage</b>
                </text>
                <text fg={muted}>{result.error}</text>
              </box>
            ))
            return
          }

          // ── Render report in dialog ──────────────────────────────────────
          const { models, totalInput, totalOutput, totalCost } = result
          const totalTokens = totalInput + totalOutput
          const hasCost = totalCost > 0
          const emptyResult = models.length === 0

          api.ui.dialog.replace(() => {
            onMount(() => {
              api.ui.dialog.setSize("large")
            })
            return (
              <box paddingLeft={2} paddingRight={2} flexDirection="column" gap={1}>
                <box flexDirection="row" justifyContent="space-between">
                  <box flexDirection="column" gap={0}>
                    <text fg={fg}><b>This Month Usage</b></text>
                    <text fg={muted}>{label}</text>
                  </box>
                  <text fg={muted}>esc</text>
                </box>
                {emptyResult ? (
                  <box paddingBottom={1}>
                    <text> </text>
                    <text fg={muted}>No usage data for {label}.</text>
                  </box>
                ) : (
                  <box paddingBottom={1}>
                    <>
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
                            <text fg={barColor(pct, theme)}>{buildBar(pct, 50)}</text>
                            {i < models.length - 1 && <text> </text>}
                          </box>
                        )
                      })}
                    </>
                  </box>
                )}
              </box>
            )
          })
        },
      },
    ],
  })
}
