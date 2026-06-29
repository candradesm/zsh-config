import { mkdirSync, appendFileSync } from "node:fs"
import type { CopilotConfig, MessagePart } from "./types"

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

export function roundUsage(value: number): number {
  let rounded = Math.round(value * 100) / 100
  // Handle imprecise multiplier artifacts (0.33 ≈ 1/3):
  // 2×0.33=0.65→0.67, 4×0.33=1.32→1.33, etc.
  let cents = Math.round((rounded % 1) * 100)
  if (cents > 0 && cents < 100 && cents % 33 === 32) {
    rounded = Math.round((rounded + 0.01) * 100) / 100
    cents = Math.round((rounded % 1) * 100)
  }
  // Handle .99 → round up (3×0.33=0.99→1.00)
  if (cents === 99) {
    return Math.ceil(rounded)
  }
  return rounded
}

// ─── Model helpers ────────────────────────────────────────────────────────────

export function getModelId(modelName: string): string | null {
  if (!modelName) return null
  const parts = modelName.split("/")
  if (parts.length < 2) return null
  const provider = parts[0]
  if (!provider.includes("copilot") && provider !== "opencode-go") return null
  return parts.slice(1).join("/")
}

export function getMultiplier(modelName: string, config: CopilotConfig): number {
  const modelId = getModelId(modelName)
  if (!modelId) return 1.0
  if (config.modelMultipliers[modelId] !== undefined) {
    return config.modelMultipliers[modelId]
  }
  const normalized = modelId.toLowerCase()
  for (const [key, value] of Object.entries(config.modelMultipliers)) {
    if (key.toLowerCase() === normalized) return value
  }
  return 1.0
}

export function isModelDeprecated(modelId: string, config: CopilotConfig): boolean {
  if (!modelId) return false
  const normalized = modelId.toLowerCase()
  return config.deprecated.some((d) => d.toLowerCase() === normalized)
}

export function isSupportedModel(modelName: string): boolean {
  if (!modelName) return false
  const lower = modelName.toLowerCase()
  return lower.includes("copilot") || lower.includes("opencode-go")
}

export function isSyntheticMessage(parts: MessagePart[]): boolean {
  // Messages with a "compaction" type part are the real compaction request — always count them.
  if (parts.some((p) => p.type === "compaction")) return false
  // The synthetic *continuation* message (auto-created after compaction to resume the chat)
  // has ONLY {type:"text", synthetic:true} parts and nothing else.
  // Real user messages may also contain synthetic text parts (e.g. the first message in a
  // session after context refill), but they always have at least one non-synthetic part too
  // (e.g. a plain "text" part, a "file" part, etc.).
  const syntheticTextParts = parts.filter((p) => p.type === "text" && p.synthetic === true)
  if (syntheticTextParts.length === 0) return false
  const nonSyntheticParts = parts.filter((p) => !(p.type === "text" && p.synthetic === true))
  return nonSyntheticParts.length === 0
}

export function calculateMessageMultiplier(
  msgId: string,
  parts: MessagePart[],
  model: string | null,
  isFreePlan: boolean,
  config: CopilotConfig,
  messageMultipliers: Map<string, number>
): number {
  if (isSyntheticMessage(parts)) {
    // Don't store in map — storing 0 would permanently blacklist the message ID,
    // preventing any future retry if parts change (e.g. message.updated fires again).
    log("calculateMessageMultiplier: skipping synthetic message", msgId)
    return 0
  }

  if (!model || getModelId(model) === null) {
    // Don't store in map — allows retry when the model becomes available on the next event fire.
    log("calculateMessageMultiplier: no copilot model for", msgId, "model:", model)
    return 0
  }

  const multiplier = isFreePlan ? 1.0 : getMultiplier(model, config)
  log("calculateMessageMultiplier:", msgId, "model:", model, "multiplier:", multiplier)
  // Only store positive results — the deduplication guard in message.updated checks this map.
  messageMultipliers.set(msgId, multiplier)
  return multiplier
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
