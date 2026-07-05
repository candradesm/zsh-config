import { mkdirSync, appendFileSync } from "node:fs"

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
