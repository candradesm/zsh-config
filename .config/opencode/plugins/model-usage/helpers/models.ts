/**
 * Model stats helper module.
 * Utilities to aggregate model usage records.
 */

// ─── Types ───────────────────────────────────────────────────────────────────

export interface ModelUsageRecord {
  providerID: string
  modelID: string
  inputTokens: number
  outputTokens: number
  cacheRead: number
  cacheWrite: number
  cost: number
  visibleOutputTokens: number
}

export interface ModelStat {
  providerID: string
  modelID: string
  msgCount: number
  inputTokens: number
  outputTokens: number
  cacheRead: number
  cacheWrite: number
  cost: number
  visibleOutputTokens: number
}

// ─── Aggregation ─────────────────────────────────────────────────────────────

/**
 * Groups records by `${providerID}/${modelID}` and sums each numeric field per group.
 * msgCount is the number of records in that group.
 * Returns an unsorted array (one entry per distinct provider/model pair).
 */
export function aggregateModelStats(records: readonly ModelUsageRecord[]): ModelStat[] {
  const groups = new Map<string, ModelStat>()

  for (const r of records) {
    const key = `${r.providerID}/${r.modelID}`
    const existing = groups.get(key)

    if (existing) {
      existing.msgCount += 1
      existing.inputTokens += r.inputTokens
      existing.outputTokens += r.outputTokens
      existing.cacheRead += r.cacheRead
      existing.cacheWrite += r.cacheWrite
      existing.cost += r.cost
      existing.visibleOutputTokens += r.visibleOutputTokens
    } else {
      groups.set(key, {
        providerID: r.providerID,
        modelID: r.modelID,
        msgCount: 1,
        inputTokens: r.inputTokens,
        outputTokens: r.outputTokens,
        cacheRead: r.cacheRead,
        cacheWrite: r.cacheWrite,
        cost: r.cost,
        visibleOutputTokens: r.visibleOutputTokens,
      })
    }
  }

  return Array.from(groups.values())
}
