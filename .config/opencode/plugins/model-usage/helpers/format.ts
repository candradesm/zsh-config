/** Maximum character length for message previews in hotspot UI. */
export const PREVIEW_MAX_LEN = 40

export function fmt(n: number): string {
  return n.toLocaleString("en-US")
}

export function fmtCost(n: number): string {
  return `$${n.toFixed(2)}`
}

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

export function truncateLabel(label: string, maxLen: number = 26): string {
  if (label.length <= maxLen) return label.padEnd(maxLen)
  return label.slice(0, maxLen - 1) + "\u2026"
}

/**
 * Compact "k"-suffixed formatting for large deltas.
 * E.g., fmtCompact(45230) -> "45k", fmtCompact(999) -> "999",
 * fmtCompact(-1500) -> "-2k". Rounds to nearest thousand, keeps sign.
 */
export function fmtCompact(n: number): string {
  if (Math.abs(n) < 1000) {
    return String(n)
  }
  return `${Math.round(n / 1000)}k`
}

export function formatPercentDiff(current: number, previous: number | null): { arrow: string; text: string } {
  if (previous == null || previous === 0) {
    return { arrow: "\u2014", text: "\u2014" }
  }
  const diff = ((current - previous) / previous) * 100
  if (diff > 0) {
    return { arrow: "\u25b2", text: `+${Math.round(diff)}%` }
  }
  if (diff < 0) {
    return { arrow: "\u25bc", text: `${Math.round(diff)}%` }
  }
  return { arrow: "\u2014", text: "\u2014" }
}
