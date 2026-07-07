/**
 * Model stats helper module.
 * Utilities to aggregate model usage records.
 */

import { log } from "./debug"

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
  lastCallRawPromptTokens?: number
  peakInputTokens: number
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
  lastCallRawPromptTokens?: number
  peakInputTokens: number
}

// ─── Aggregation ─────────────────────────────────────────────────────────────

/**
 * Groups records by `${providerID}/${modelID}` and sums each numeric field per group.
 * msgCount is the number of records in that group.
 * Returns an unsorted array (one entry per distinct provider/model pair).
 */
export function aggregateModelStats(records: readonly ModelUsageRecord[]): ModelStat[] {
  log(`aggregateModelStats: starting aggregation for ${records.length} records`)
  const groups = new Map<string, ModelStat>()

  for (const r of records) {
    const key = `${r.providerID}/${r.modelID}`
    const existing = groups.get(key)

    if (existing) {
      const oldLastCallPrompt = existing.lastCallRawPromptTokens
      existing.msgCount += 1
      existing.inputTokens += r.inputTokens
      existing.outputTokens += r.outputTokens
      existing.cacheRead += r.cacheRead
      existing.cacheWrite += r.cacheWrite
      existing.cost += r.cost
      existing.visibleOutputTokens += r.visibleOutputTokens
      existing.peakInputTokens = Math.max(existing.peakInputTokens, r.peakInputTokens)
      // Defense-in-depth: A degenerate/aborted trailing call (with zero real telemetry) must not erase
      // a real prior "last known good" prompt token value for this model. We only overwrite
      // with a newer value if that value is legitimately greater than 0.
      if (r.lastCallRawPromptTokens !== undefined && r.lastCallRawPromptTokens > 0) {
        existing.lastCallRawPromptTokens = r.lastCallRawPromptTokens
        log(`aggregateModelStats: updated ${key} - msgCount: ${existing.msgCount}, input: ${existing.inputTokens}, output: ${existing.outputTokens}, cacheRead: ${existing.cacheRead}, cacheWrite: ${existing.cacheWrite}, visibleOutput: ${existing.visibleOutputTokens}, cost: ${existing.cost}, lastCallRawPrompt updated from ${oldLastCallPrompt} to ${r.lastCallRawPromptTokens}`)
      } else {
        log(`aggregateModelStats: updated ${key} - msgCount: ${existing.msgCount}, input: ${existing.inputTokens}, output: ${existing.outputTokens}, cacheRead: ${existing.cacheRead}, cacheWrite: ${existing.cacheWrite}, visibleOutput: ${existing.visibleOutputTokens}, cost: ${existing.cost}, lastCallRawPrompt retained at ${existing.lastCallRawPromptTokens} (new was ${r.lastCallRawPromptTokens})`)
      }
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
        lastCallRawPromptTokens: r.lastCallRawPromptTokens,
        peakInputTokens: r.peakInputTokens,
      })
      log(`aggregateModelStats: created new group ${key} - input: ${r.inputTokens}, output: ${r.outputTokens}, cacheRead: ${r.cacheRead}, cacheWrite: ${r.cacheWrite}, visibleOutput: ${r.visibleOutputTokens}, cost: ${r.cost}, lastCallRawPrompt: ${r.lastCallRawPromptTokens}`)
    }
  }

  const result = Array.from(groups.values())
  log(`aggregateModelStats: completed aggregation into ${result.length} unique model groups`)
  return result
}
