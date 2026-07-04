import { Database } from "bun:sqlite"
import type { ModelUsage, UsageRow, UsageData } from "./types"

const MAX_MODELS = 10

export function queryUsage(dbPath: string, startMs: number, endMs: number): UsageData | { error: string } {
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
         LIMIT ${MAX_MODELS}`,
      )
      .all(startMs, endMs) as UsageRow[]

    db.close()
    db = null

    let totalInput = 0
    let totalOutput = 0
    let totalCost = 0

    const models: ModelUsage[] = (rows ?? [])
      .filter((r: UsageRow) => r.provider_id && r.model_id)
      .map((r: UsageRow) => {
        const inp = Math.max(0, r.total_input ?? 0)
        const out = Math.max(0, r.total_output ?? 0)
        const cost = Math.max(0, r.total_cost ?? 0)
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

export function getEarliestUsageDate(dbPath: string): number | null {
  let db: Database | null = null
  try {
    db = new Database(dbPath, { readonly: true })
    const row = db
      .query(
        `SELECT MIN(time_created) AS earliest
         FROM message
         WHERE json_extract(data, '$.role') = 'assistant'`
      )
      .get() as { earliest: number | null } | undefined
    db.close()
    db = null
    return row?.earliest ?? null
  } catch {
    return null
  } finally {
    try { db?.close() } catch { /* ignore */ }
  }
}

/**
 * Tier 1 system-token source: read the full assembled system baseline that the
 * V2 native runner persists to `session_context_epoch.baseline` on every turn
 * (written by `packages/core/src/session/context-epoch.ts`). Returns the raw
 * baseline string, or `null` if the table is empty for this session (V1 / AI
 * SDK path) or the table does not exist.
 *
 * The caller is responsible for tokenising the returned text (char/4).
 */
export function loadBaseline(dbPath: string, sessionID: string): string | null {
  let db: Database | null = null
  try {
    db = new Database(dbPath, { readonly: true })
    // Guard against older OpenCode builds that lack the table.
    const table = db
      .query(`SELECT name FROM sqlite_master WHERE type='table' AND name='session_context_epoch'`)
      .get() as { name: string } | undefined
    if (!table) return null
    const row = db
      .query(`SELECT baseline FROM session_context_epoch WHERE session_id = ?`)
      .get(sessionID) as { baseline: string } | undefined
    db.close()
    db = null
    if (!row || typeof row.baseline !== "string" || row.baseline.length === 0) return null
    return row.baseline
  } catch {
    return null
  } finally {
    try { db?.close() } catch { /* ignore */ }
  }
}
