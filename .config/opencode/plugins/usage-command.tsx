/** @jsxImportSource @opentui/solid */
import type { TuiPlugin, TuiPluginModule } from "@opencode-ai/plugin/tui"
import { Database } from "bun:sqlite"
import { existsSync } from "node:fs"

// ─── Types ───────────────────────────────────────────────────────────────────

interface ModelUsage {
  providerId: string
  modelId: string
  totalCost: number
  totalInput: number
  totalOutput: number
}

interface UsageData {
  models: ModelUsage[]
  totalInput: number
  totalOutput: number
  totalCost: number
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function getMonthBounds(): [number, number] {
  const now = new Date()
  const start = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)
  const end = Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1)
  return [start, end]
}

function getMonthLabel(): string {
  return new Date().toLocaleString("en-US", { month: "long", year: "numeric" })
}

function fmt(n: number): string {
  return n.toLocaleString("en-US")
}

function fmtCost(n: number): string {
  if (n >= 1) return `$${n.toFixed(2)}`
  if (n >= 0.01) return `$${n.toFixed(3)}`
  return `$${n.toFixed(4)}`
}

function buildBar(percentage: number, width: number = 30): string {
  const clamped = Math.max(0, Math.min(100, percentage))
  const filled = Math.max(0, Math.round((clamped / 100) * width))
  return "\u2588".repeat(filled) + "\u2591".repeat(width - filled)
}

function barColor(percentage: number, theme: any): string {
  if (percentage > 50) return theme?.green ?? "#22c55e"
  if (percentage > 25) return theme?.yellow ?? "#eab308"
  return theme?.muted ?? "#888888"
}

// ─── DB Query ────────────────────────────────────────────────────────────────

function queryUsage(dbPath: string): UsageData | { error: string } {
  const [startMs, endMs] = getMonthBounds()

  let db: Database | null = null
  try {
    db = new Database(dbPath, { readonly: true })

    const rows = db
      .query(
        `SELECT
           json_extract(data, '$.modelID')                     AS model_id,
           json_extract(data, '$.providerID')                  AS provider_id,
           SUM(CAST(json_extract(data, '$.cost') AS REAL))     AS total_cost,
           SUM(CAST(json_extract(data, '$.tokens.input')  AS INTEGER)) AS total_input,
           SUM(CAST(json_extract(data, '$.tokens.output') AS INTEGER)) AS total_output
         FROM message
         WHERE json_extract(data, '$.role') = 'assistant'
           AND time_created >= ?
           AND time_created <  ?
         GROUP BY provider_id, model_id
         ORDER BY (total_input + total_output) DESC
         LIMIT 10`,
      )
      .all(startMs, endMs) as any[]

    db.close()
    db = null

    let totalInput = 0
    let totalOutput = 0
    let totalCost = 0

    const models: ModelUsage[] = (rows ?? [])
      .filter((r: any) => r.provider_id && r.model_id)
      .map((r: any) => {
        const inp = r.total_input ?? 0
        const out = r.total_output ?? 0
        const cost = r.total_cost ?? 0
        totalInput += inp
        totalOutput += out
        totalCost += cost
        return {
          providerId: r.provider_id,
          modelId: r.model_id,
          totalCost: cost,
          totalInput: inp,
          totalOutput: out,
        }
      })

    return { models, totalInput, totalOutput, totalCost }
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) }
  } finally {
    try {
      db?.close()
    } catch {
      /* already closed */
    }
  }
}

// ─── Plugin ──────────────────────────────────────────────────────────────────

const tui: TuiPlugin = async (api) => {
  api.keymap.registerLayer({
    commands: [
      {
        name: "usage.show",
        title: "Show Monthly Usage",
        category: "Plugin",
        namespace: "palette",
        slashName: "usage",
        run() {
          const theme = api.theme.current
          const statePath = api.path.get().state
          const dbPath = `${statePath}/opencode.db`

          const fg = theme?.foreground ?? "#ffffff"
          const muted = theme?.muted ?? "#888888"
          const red = theme?.red ?? "#ef4444"

          // ── DB not found ────────────────────────────────────────────────
          if (!existsSync(dbPath)) {
            api.ui.dialog.setSize("medium")
            api.ui.dialog.replace(() => (
              <box padding={2} flexDirection="column" gap={1}>
                <text fg={red}>
                  <b>Usage Data Unavailable</b>
                </text>
                <text fg={muted}>
                  Database not found at the expected location.
                </text>
                <text fg={muted}>Please try again later.</text>
              </box>
            ))
            return
          }

          // ── Loading ──────────────────────────────────────────────────────
          api.ui.dialog.setSize("large")
          api.ui.dialog.replace(() => (
            <box padding={2} flexDirection="column" gap={1}>
              <text fg={fg}>
                <b>Loading usage data…</b>
              </text>
            </box>
          ))

          // ── Query ────────────────────────────────────────────────────────
          const result = queryUsage(dbPath)

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

          const { models, totalInput, totalOutput, totalCost } = result
          const totalTokens = totalInput + totalOutput

          // ── No data ──────────────────────────────────────────────────────
          if (models.length === 0 || totalTokens === 0) {
            api.ui.dialog.replace(() => (
              <box padding={2} flexDirection="column" gap={1}>
                <text fg={fg}>
                  <b>This Month Usage</b>
                </text>
                <text fg={muted}>
                  No usage data for {getMonthLabel()}.
                </text>
              </box>
            ))
            return
          }

          // ── Render results ───────────────────────────────────────────────
          const hasCost = totalCost > 0

          api.ui.dialog.replace(() => (
            <box padding={1} flexDirection="column" gap={0}>
              {/* Header */}
              <text fg={fg}>
                <b>This Month Usage</b>
              </text>
              <text fg={muted}>{getMonthLabel()}</text>
              <text> </text>

              {/* Totals */}
              <text fg={fg}>
                Total: {fmt(totalTokens)} tokens
                {hasCost ? ` (${fmtCost(totalCost)})` : ""}
              </text>
              <text fg={muted}>  ↑ Input:  {fmt(totalInput)} tokens</text>
              <text fg={muted}>  ↓ Output: {fmt(totalOutput)} tokens</text>
              <text> </text>

              {/* Per Model */}
              <text fg={fg}>
                <b>Per Model</b> (top {models.length})
              </text>
              <text> </text>

              {models.map((m, i) => {
                const modelTokens = m.totalInput + m.totalOutput
                const pct = totalTokens > 0 ? (modelTokens / totalTokens) * 100 : 0
                const displayName = `${m.providerId}/${m.modelId}`
                const modelHasCost = m.totalCost > 0

                return (
                  <box flexDirection="column" gap={1}>
                    <text fg={fg}>
                      {i + 1}. {displayName}
                    </text>
                    <text fg={muted}>
                      {"   "}
                      {fmt(modelTokens)} tokens ({pct.toFixed(1)}%)
                      {modelHasCost ? ` — ${fmtCost(m.totalCost)}` : ""}
                    </text>
                    <text fg={barColor(pct, theme)}>{buildBar(pct)}</text>
                    {i < models.length - 1 && <text> </text>}
                  </box>
                )
              })}
            </box>
          ))
        },
      },
    ],
  })
}

// ─── Export ──────────────────────────────────────────────────────────────────

const plugin: TuiPluginModule & { id: string } = {
  id: "usage-command",
  tui,
}

export default plugin
