/**
 * Compaction helper module.
 * Utilities to summarize compaction events and compute token reductions.
 */

// ─── Types ───────────────────────────────────────────────────────────────────

export interface CompactionEvent {
  beforeTokens: number
  afterTokens: number
}

export interface CompactionSummary {
  count: number
  reductionTokens: number
}

// ─── Summarization ───────────────────────────────────────────────────────────

/**
 * Summarizes a list of compaction events.
 * Computes the total number of events and the sum of token reductions.
 * 
 * Events where afterTokens >= beforeTokens contribute 0 to reductionTokens
 * but still count towards the total count.
 */
export function summarizeCompactions(events: readonly CompactionEvent[]): CompactionSummary {
  const count = events.length
  let reductionTokens = 0

  for (const event of events) {
    reductionTokens += Math.max(0, event.beforeTokens - event.afterTokens)
  }

  return {
    count,
    reductionTokens,
  }
}
