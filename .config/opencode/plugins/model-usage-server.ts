import { homedir } from "node:os"
import { mkdirSync, existsSync, readFileSync, writeFileSync } from "node:fs"
import { estimateTokens, splitSystemFragments } from "./model-usage/helpers"
import type { SystemSnapshot } from "./model-usage/types"

const TOKENS_DIR = `${homedir()}/.config/opencode/plugins/model-usage`
const TOKENS_FILE = `${TOKENS_DIR}/system-tokens.json`
const MAX_ENTRIES = 1000
const PURGE_COUNT = 100
// Only flush to disk if the token count drifted by this many tokens since the
// last persisted value — avoids re-writing the file when nothing material
// changed (e.g. identical system on a cached re-fire).
const DRIFT_THRESHOLD = 32

// Serialized writes to prevent race conditions from concurrent API calls
let writeQueue: Promise<void> = Promise.resolve()

function ensureDir() {
  try { mkdirSync(TOKENS_DIR, { recursive: true }) } catch { /* ignore */ }
}

function loadTokens(): Record<string, SystemSnapshot> {
  ensureDir()
  try {
    if (existsSync(TOKENS_FILE)) {
      return JSON.parse(readFileSync(TOKENS_FILE, "utf-8"))
    }
  } catch { /* ignore */ }
  return {}
}

function saveTokens(data: Record<string, SystemSnapshot>): Promise<void> {
  // Purge oldest entries if over limit (FIFO by timestamp).
  const entries = Object.entries(data)
  if (entries.length > MAX_ENTRIES) {
    const sorted = entries.sort((a, b) => a[1].ts - b[1].ts)
    const toKeep = sorted.slice(PURGE_COUNT)
    data = Object.fromEntries(toKeep)
  }

  // Serialize writes via promise chain
  writeQueue = writeQueue.then(() => {
    ensureDir()
    try {
      writeFileSync(TOKENS_FILE, JSON.stringify(data))
    } catch { /* ignore */ }
  })
  return writeQueue
}

function isTitleGenerator(system: string[]): boolean {
  // Title-generation calls fire the same hook with a tiny "You are a title
  // generator" system. They are NOT the real session system prompt and would
  // pollute the entry if stored. Mirror jungle-mode-server.ts:38.
  return system.join("\n").toLowerCase().includes("title generator")
}

export const ModelUsageServerPlugin = async () => {
  // In-memory cache (disk is source of truth). We deliberately do NOT freeze
  // sessions: the system can grow mid-session (new refs/MCP/skills) and we want
  // the LATEST measurement, not the first.
  const cache = new Map<string, SystemSnapshot>()
  const existing = loadTokens()
  for (const [sid, entry] of Object.entries(existing)) cache.set(sid, entry)

  return {
    "experimental.chat.system.transform": async (
      _input: { sessionID?: string; model: any },
      output: { system: string[] },
    ) => {
      const sessionID = _input.sessionID
      if (!sessionID || !output.system || output.system.length === 0) return
      if (isTitleGenerator(output.system)) return

      const allText = output.system.join("\n")
      if (allText.trim().length === 0) return

      const now = Date.now()
      const tokens = estimateTokens(allText)
      const fragments = splitSystemFragments(allText)

      const prev = cache.get(sessionID)

      if (prev) {
        // Compaction / major change: if the new measurement is dramatically
        // smaller (< 70% of previous), the system was likely replaced (e.g.
        // post-compaction baseline). Overwrite with the new (smaller) one.
        if (tokens < prev.t * 0.7) {
          const entry: SystemSnapshot = { t: tokens, ts: now, fragments, rawText: allText }
          cache.set(sessionID, entry)
          existing[sessionID] = entry
          await saveTokens(existing)
          return
        }

        // No material change since last persist → just refresh timestamp
        // occasionally (throttle I/O) and bail. Now that jungle-mode injects
        // on every call, the latest measurement IS the most accurate.
        if (Math.abs(tokens - prev.t) <= DRIFT_THRESHOLD) {
          // Backfill rawText for entries captured before it was stored.
          if (!prev.fragments || prev.fragments.length === 0) {
            prev.rawText = allText
            prev.fragments = fragments
            prev.ts = now
            await saveTokens(existing)
          } else if (now - prev.ts >= 5 * 60 * 1000) {
            prev.ts = now
            await saveTokens(existing)
          }
          return
        }
      }

      // Material change (or first measurement) → store latest + fragments.
      const entry: SystemSnapshot = { t: tokens, ts: now, fragments, rawText: allText }
      cache.set(sessionID, entry)
      existing[sessionID] = entry
      await saveTokens(existing)
    },
  }
}
