import type { Part } from "@opencode-ai/sdk/v2"
import { log } from "./debug"

export function estimateTokens(text: string): number {
  if (!text || text.length === 0) return 0
  return Math.ceil(text.length / 4)
}

/**
 * Estimates the visible assistant text token count from message parts using char/4.
 * Excludes tool calls/results and other non-text parts to stay consistent with ASSISTANT category.
 */
export function estimateVisibleOutputTokens(parts: readonly Part[] | undefined | null): number {
  if (!parts) {
    log("estimateVisibleOutputTokens: no parts provided, returning 0")
    return 0
  }
  const textParts = parts.filter((p) => p?.type === "text")
  const text = textParts.map((p) => p?.text ?? "").join("")
  const estimated = estimateTokens(text)
  log(`estimateVisibleOutputTokens: textParts count = ${textParts.length}, combined length = ${text.length} chars, estimated visible tokens = ${estimated}`)
  return estimated
}

/**
 * Reconstitute the RAW prompt token count (system + user + tools + cached) from
 * the adjusted values OpenCode stores on assistant messages.
 *
 * OpenCode's `session.ts:366` computes `tokens.input = raw - cacheRead - cacheWrite`
 * (non-cached input). To recover the full prompt size we must ADD both cache
 * counters back. This is provider-agnostic: works for opencode-go (no caching),
 * Anthropic (cache.write on first call), Bedrock, OpenAI/Copilot (cache.read on
 * resumed calls).
 */
export function rawPromptTokens(tokens: {
  input?: number
  cache?: { read?: number; write?: number }
}): number {
  if (!tokens) return 0
  const input = Math.max(0, tokens.input ?? 0)
  const cacheRead = Math.max(0, tokens.cache?.read ?? 0)
  const cacheWrite = Math.max(0, tokens.cache?.write ?? 0)
  return input + cacheRead + cacheWrite
}

/**
 * Scale a list of entries so their token sum matches `targetTotal`.
 * Mirrors the reference plugin's approach: `factor = target / sum`, apply to
 * each entry, push the rounding remainder onto the first entry so the sum is
 * exact. Returns a NEW array (does not mutate input).
 *
 * If `targetTotal <= 0`, all entries become 0. If `measuredSum <= 0` but
 * `targetTotal > 0`, the target is split evenly across entries.
 */
export function scaleEntries<T extends { tokens: number }>(entries: readonly T[], targetTotal: number): T[] {
  if (entries.length === 0) return []
  const out = entries.map((e) => ({ ...e }))

  if (targetTotal <= 0) {
    for (const e of out) e.tokens = 0
    return out
  }

  const measuredSum = out.reduce((s, e) => s + e.tokens, 0)
  if (measuredSum <= 0) {
    const share = Math.round(targetTotal / out.length)
    for (let i = 0; i < out.length; i++) {
      out[i].tokens = i === 0
        ? Math.max(0, Math.round(targetTotal) - share * (out.length - 1))
        : share
    }
    return out
  }

  const factor = targetTotal / measuredSum
  let accumulated = 0
  for (const e of out) {
    e.tokens = Math.max(0, Math.round(e.tokens * factor))
    accumulated += e.tokens
  }
  // Push the rounding remainder onto the first entry so the sum is exact.
  const diff = Math.round(targetTotal) - accumulated
  if (diff !== 0) {
    out[0].tokens = Math.max(0, out[0].tokens + diff)
  }
  return out
}
