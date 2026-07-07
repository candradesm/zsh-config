const MS_PER_DAY = 86_400_000

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

export function getWeekMonday(date: Date): Date {
  const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()))
  const day = d.getUTCDay()
  const diff = day === 0 ? 6 : day - 1
  d.setUTCDate(d.getUTCDate() - diff)
  d.setUTCHours(0, 0, 0, 0)
  return d
}

export function getWeekInfo(date: Date): { startMs: number; endMs: number; label: string } {
  const monday = getWeekMonday(date)
  const startMs = monday.getTime()
  const endMs = startMs + 7 * MS_PER_DAY

  const startLabel = monday.toLocaleString("en-US", { month: "short", day: "numeric", timeZone: "UTC" })
  const sunday = new Date(endMs - 1)
  const endLabel = sunday.toLocaleString("en-US", { month: "short", day: "numeric", timeZone: "UTC" })

  return { startMs, endMs, label: `${startLabel} – ${endLabel}` }
}
