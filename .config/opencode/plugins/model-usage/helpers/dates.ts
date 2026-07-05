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
