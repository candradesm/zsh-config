/**
 * Compaction helper module.
 * Utilities to summarize compaction events and compute token reductions.
 */

import { rawPromptTokens } from "./tokens"

// ─── Types ───────────────────────────────────────────────────────────────────

export interface CompactionEvent {
  beforeTokens: number
  afterTokens?: number  // undefined when next assistant not yet seen
}

export interface CompactionSummary {
  count: number
  /** How many events have afterTokens (resolved vs unresolved) */
  measured: number
  reductionTokens: number
}

// ─── Summarization ───────────────────────────────────────────────────────────

/**
 * Summarizes a list of compaction events.
 * Computes the total number of events and the sum of token reductions.
 * 
 * Events with undefined afterTokens are counted in `count` but do NOT
 * contribute to reductionTokens nor `measured`.
 * Events where afterTokens >= beforeTokens contribute 0 to reductionTokens
 * but still count towards `measured`.
 */
export function summarizeCompactions(events: readonly CompactionEvent[]): CompactionSummary {
  const count = events.length
  let measured = 0
  let reductionTokens = 0

  for (const event of events) {
    if (event.afterTokens !== undefined) {
      measured++
      reductionTokens += Math.max(0, event.beforeTokens - event.afterTokens)
    }
  }

  return {
    count,
    measured,
    reductionTokens,
  }
}

// ─── Resolution ──────────────────────────────────────────────────────────────

/**
 * Pure function that iterates over raw session messages and extracts compaction
 * events with resolved before/after tokens from adjacent assistant rawPromptTokens.
 *
 * Design notes:
 * - If two compactions happen with no assistant between them, the second
 *   compaction's `before` will reuse the first compaction's prior assistant
 *   value (stale). This is rare and acceptable.
 * - Title-gen stubs (rawPromptTokens === 0) are skipped for backfill and
 *   lastAssistantRawPrompt tracking.
 */
export function resolveCompactionEvents(messages: any[]): { events: CompactionEvent[], summary: CompactionSummary } {
  const events: CompactionEvent[] = []
  let lastAssistantRawPrompt: number | undefined = undefined

  for (const msg of messages) {
    const info = msg.info
    if (info.role !== "assistant" && info.role !== "user") continue
    const parts: any[] = msg.parts ?? []

    // Check for compaction part (signals a compaction summary message)
    const hasCompaction = parts.some((p: any) => p.type === "compaction")

    if (hasCompaction) {
      events.push({
        beforeTokens: lastAssistantRawPrompt ?? 0,
        afterTokens: undefined,  // resolved when next assistant arrives
      })
    }

    // ── Assistant telemetry processing ──
    if (info.role === "assistant") {
      const asstInfo = info as any
      const providerID = asstInfo.providerID
      const modelID = asstInfo.modelID

      if (providerID && modelID) {
        const currentRawPrompt = rawPromptTokens({
          input: asstInfo.tokens?.input ?? 0,
          cache: {
            read: asstInfo.tokens?.cache?.read ?? 0,
            write: asstInfo.tokens?.cache?.write ?? 0,
          },
        })

        const hasTelemetry = currentRawPrompt > 0
          || (asstInfo.tokens?.output ?? 0) > 0
          || (asstInfo.tokens?.reasoning ?? 0) > 0
          || (asstInfo.cost ?? 0) > 0

        if (hasTelemetry && currentRawPrompt > 0) {
          // Backfill the most recent unresolved compaction event
          for (let ci = events.length - 1; ci >= 0; ci--) {
            if (events[ci].afterTokens === undefined) {
              events[ci].afterTokens = currentRawPrompt
              break  // only backfill the most recent
            }
          }
          lastAssistantRawPrompt = currentRawPrompt
        }
      }
    }
  }

  const summary = summarizeCompactions(events)
  return { events, summary }
}
