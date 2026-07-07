/**
 * Model tab helper module.
 * Pure functions for Models tab layout and model switch counting.
 * These avoid importing `@opencode-ai/plugin/tui` (no SolidJS/JSX),
 * making them importable from test files.
 */

import type { ModelStat } from "./models"

/**
 * Computes the sorted stats and total token count for the Models tab.
 *
 * Design note (deliberate trade-off): using peakInput+output for % means a
 * cold-cache-switch model can legitimately outrank a workhorse model on
 * token usage (those tokens WERE billed). This mirrors the sidebar's
 * peak-context convention: ↑ = peakInputTokens, ↓ = outputTokens, and
 * every displayed number feeds the same formula. The `msgCount`
 * counterbalances this. Reasoning-only models (o1-style, input=0, output=0,
 * reasoning>0) will show 0% — mirroring /usage which also excludes
 * reasoning from its SQL. Accepted edge case.
 */
export function computeModelsTabLayout(stats: ModelStat[]): { sortedStats: ModelStat[]; totalModelTokens: number } {
  const totalModelTokens = stats.reduce((acc, st) => acc + st.peakInputTokens + st.outputTokens, 0)

  const sortedStats = [...stats].sort((a, b) => {
    const totalA = a.peakInputTokens + a.outputTokens
    const totalB = b.peakInputTokens + b.outputTokens
    if (totalB !== totalA) return totalB - totalA
    if (b.msgCount !== a.msgCount) return b.msgCount - a.msgCount
    return `${a.providerID}/${a.modelID}`.localeCompare(`${b.providerID}/${b.modelID}`)
  })

  return { sortedStats, totalModelTokens }
}

/**
 * Counts sequential model transitions on the RAW message stream (not the
 * filtered ledger). Iterates messages, filters to assistants with
 * providerID+modelID, counts when `${providerID}/${modelID}` changes
 * between consecutive assistants. Excludes title-gen calls (where
 * rawPromptTokens === 0) which would inflate switches with title-model
 * noise.
 */
export function countModelSwitches(messages: any[]): number {
  let lastModelKey = ""
  let switches = 0

  for (const msg of messages) {
    const info = msg.info
    if (info.role !== "assistant") continue
    const asstInfo = info as any
    const providerID = asstInfo.providerID
    const modelID = asstInfo.modelID
    if (!providerID || !modelID) continue

    // Compute raw prompt to detect title-gen calls (rawPromptTokens === 0)
    const currentRawPrompt =
      (asstInfo.tokens?.input ?? 0) +
      (asstInfo.tokens?.cache?.read ?? 0) +
      (asstInfo.tokens?.cache?.write ?? 0)

    // Exclude title-gen calls where rawPromptTokens === 0
    if (currentRawPrompt === 0) continue

    const modelKey = `${providerID}/${modelID}`
    if (lastModelKey && lastModelKey !== modelKey) {
      switches++
    }
    lastModelKey = modelKey
  }

  return switches
}
