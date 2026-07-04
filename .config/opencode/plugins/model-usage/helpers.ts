import { mkdirSync, appendFileSync } from "node:fs"
import type { SystemFragment } from "./types"

export const DEBUG = process.env.OPENCODE_COPILOT_DEBUG === "true"
export const logsDir = new URL("../logs", import.meta.url).pathname
export const logPath = new URL(`../logs/log_copilot_plugin_${Date.now()}.log`, import.meta.url).pathname
if (DEBUG) mkdirSync(logsDir, { recursive: true })

export function log(...args: unknown[]) {
  if (!DEBUG) return
  try {
    const line = `[${new Date().toISOString()}] ${args.map(String).join(" ")}\n`
    appendFileSync(logPath, line)
  } catch {
    // ignore
  }
}

// ─── Date helpers ─────────────────────────────────────────────────────────────

export function getMonthInfo(year?: number, month?: number): { startMs: number; endMs: number; label: string } {
  const now = new Date()
  const y = year ?? now.getUTCFullYear()
  const m = month ?? now.getUTCMonth()
  const startMs = Date.UTC(y, m, 1)
  const endMs = Date.UTC(y, m + 1, 1)
  const label = new Date(Date.UTC(y, m, 1)).toLocaleString("en-US", { month: "long", year: "numeric", timeZone: "UTC" })
  return { startMs, endMs, label }
}

export function isCurrentMonth(startMs: number): boolean {
  const now = new Date()
  const currentStart = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)
  return startMs === currentStart
}

export function fmt(n: number): string {
  return n.toLocaleString("en-US")
}

export function fmtCost(n: number): string {
  return `$${n.toFixed(2)}`
}

// ─── Bar helpers ──────────────────────────────────────────────────────────────

export function buildBar(percentage: number, width: number = 50): string {
  const clamped = Math.max(0, Math.min(100, percentage))
  const filled = Math.max(0, Math.round((clamped / 100) * width))
  return "\u2588".repeat(filled) + "\u2591".repeat(width - filled)
}

export function buildProgressBar(percentage: number, width: number = 20): string {
  const filled = Math.min(Math.round((percentage / 100) * width), width)
  const empty = width - filled
  return "\u2588".repeat(filled) + "\u2591".repeat(empty)
}

export function getUsageColor(percentage: number): string {
  if (percentage > 100) return "#ef4444"
  if (percentage > 90) return "#ef4444"
  if (percentage > 75) return "#eab308"
  return "#22c55e"
}

// ─── Model helpers ────────────────────────────────────────────────────────────

export function isSupportedModel(modelName: string): boolean {
  if (!modelName) return false
  const lower = modelName.toLowerCase()
  return lower.includes("copilot") || lower.includes("opencode-go")
}

// ─── Formatting helpers ───────────────────────────────────────────────────────

export function formatDuration(seconds: number): string {
  if (seconds < 60) return `${seconds}s`
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`
  if (seconds < 86400) {
    const h = Math.floor(seconds / 3600)
    const m = Math.floor((seconds % 3600) / 60)
    return m > 0 ? `${h}h ${m}m` : `${h}h`
  }
  const d = Math.floor(seconds / 86400)
  const h = Math.floor((seconds % 86400) / 3600)
  return h > 0 ? `${d}d ${h}h` : `${d}d`
}

export function getQuotaLabel(quota: { planType: string; quotaType: string }): string {
  if (quota.planType === "free") return "chat requests"
  if (quota.quotaType === "ai_credits") return "AI Credits"
  return "premium requests"
}

export function splitCost(
  deltaInput: number,
  deltaCacheRead: number,
  deltaOutput: number,
  deltaCost: number,
  modelId: string,
  provider: ReadonlyArray<any>
): { inputCost: number; outputCost: number } {
  let inputPrice = 0
  let outputPrice = 0
  let cacheReadPrice = 0

  for (const p of provider) {
    const model = p.models?.[modelId]
    if (model?.cost) {
      inputPrice = model.cost.input ?? 0
      outputPrice = model.cost.output ?? 0
      cacheReadPrice = model.cost.cache?.read ?? 0
      break
    }
  }

  // If no pricing found, fall back to raw token proportional split
  if (inputPrice === 0 && outputPrice === 0) {
    const totalTok = deltaInput + deltaCacheRead + deltaOutput
    if (totalTok === 0) return { inputCost: 0, outputCost: 0 }
    return {
      inputCost: deltaCost * (deltaInput + deltaCacheRead) / totalTok,
      outputCost: deltaCost * deltaOutput / totalTok,
    }
  }

  // Price-weighted split
  const inputWeight = (deltaInput * inputPrice + deltaCacheRead * cacheReadPrice) / 1_000_000
  const outputWeight = (deltaOutput * outputPrice) / 1_000_000
  const totalWeight = inputWeight + outputWeight

  if (totalWeight === 0) return { inputCost: 0, outputCost: 0 }

  return {
    inputCost: deltaCost * inputWeight / totalWeight,
    outputCost: deltaCost * outputWeight / totalWeight,
  }
}

// ─── Token estimation ─────────────────────────────────────────────────────────

export function estimateTokens(text: string): number {
  if (!text || text.length === 0) return 0
  return Math.ceil(text.length / 4)
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

/**
 * Split an assembled system prompt into labelled fragments by markdown header,
 * jungle-mode `Instructions from:` markers, and XML-like section blocks
 * (`<available_references>`, `<mcp_instructions>`, `<available_skills>`).
 * Each fragment's tokens are estimated with char/4.  Pure / testable.
 */
export function splitSystemFragments(systemText: string, maxFragments = 100): SystemFragment[] {
  if (!systemText || systemText.trim().length === 0) return []
  const lines = systemText.split("\n")
  const buckets: { label: string; text: string }[] = []
  let current: { label: string; text: string } | null = null
  let xmlMode = false
  let xmlCloseTag = ""
  let pluginMode = false
  let pluginBlankCount = 0

  // Top-level XML sections in the assembled system prompt (system.ts,
  // skill.ts). Only these three tags start a new fragment; inner tags
  // like <example>, <server>, <reference>, <skill> are content.
  const sectionOpen = /^<(available_references|mcp_instructions|available_skills)>/
  const friendlyLabel: Record<string, string> = {
    available_references: "References",
    mcp_instructions: "MCP Instructions",
    available_skills: "Skills",
  }

  const push = () => {
    if (current && current.text.trim().length > 0) buckets.push(current)
    current = null
  }

  for (const line of lines) {
    // Inside a multi-line XML block: collect until the closing tag.
    if (xmlMode) {
      current!.text += line + "\n"
      if (line.includes(xmlCloseTag)) {
        push()
        xmlMode = false
      }
      continue
    }

    // Inside a plugin-injected section (e.g. jungle-mode persona):
    // collect everything until two consecutive blank lines — the
    // boundary between the plugin section and the original system prompt.
    // Headers within this section (like `## 🍌 JUNGLE MODE ACTIVE 🍌`)
    // are content, not separate fragments.
    if (pluginMode) {
      current!.text += line + "\n"
      if (line.trim().length === 0) {
        pluginBlankCount++
        if (pluginBlankCount >= 2) {
          push()
          pluginMode = false
        }
      } else {
        pluginBlankCount = 0
      }
      continue
    }

    // XML block start (section-level only).
    const xmlMatch = sectionOpen.exec(line)
    if (xmlMatch) {
      const tag = xmlMatch[1]
      push()
      current = { label: friendlyLabel[tag] ?? tag.replace(/_/g, " "), text: line + "\n" }
      xmlCloseTag = `</${tag}>`
      if (line.includes(xmlCloseTag)) {
        push()
      } else {
        xmlMode = true
      }
      continue
    }

    const header = /^(#{1,3})\s+(.+)$/.exec(line)
    const jungle = /^Instructions from:\s*(.+)$/.exec(line)
    if (header) {
      push()
      current = { label: header[2].trim().slice(0, 48), text: line + "\n" }
    } else if (jungle) {
      push()
      current = { label: jungle[1].trim().slice(0, 48), text: line + "\n" }
      // Only enter plugin mode for jungle-mode injections (collect until
      // double blank line). Other Instructions from: lines (e.g. AGENTS.md
      // file references) are regular section headers — don't swallow their
      // content into plugin mode.
      if (/^jungle-mode\//.test(jungle[1].trim())) {
        pluginMode = true
        pluginBlankCount = 0
      }
    } else if (current) {
      current.text += line + "\n"
    } else {
      // Preamble before any header — bucket as "preamble".
      current = { label: "preamble", text: line + "\n" }
    }
  }
  push()

  const frags: SystemFragment[] = buckets.map((b) => ({
    label: b.label || "section",
    tokens: estimateTokens(b.text),
  }))

  if (frags.length <= maxFragments) return frags.sort((a, b) => b.tokens - a.tokens)

  const sorted = frags.sort((a, b) => b.tokens - a.tokens)
  const kept = sorted.slice(0, maxFragments)
  const otherTotal = sorted.slice(maxFragments).reduce((s, f) => s + f.tokens, 0)
  if (otherTotal > 0) kept.push({ label: "other", tokens: otherTotal })
  return kept
}
