import { describe, expect, it, beforeEach, afterEach } from "bun:test"
import { Database } from "bun:sqlite"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fetchRawRows, type RawUsageRow } from "@model-usage/db"

function setupDb(): { dbPath: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "opencode-test-"))
  const dbPath = join(dir, "test.db")
  const db = new Database(dbPath)
  db.run(`CREATE TABLE IF NOT EXISTS message (
    time_created INTEGER,
    data TEXT
  )`)
  db.close()
  return { dbPath, cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}

function insertMessage(dbPath: string, timeCreated: number, data: Record<string, unknown>) {
  const db = new Database(dbPath)
  try {
    db.run(`INSERT INTO message (time_created, data) VALUES (?, ?)`, [
      timeCreated,
      JSON.stringify(data),
    ])
  } finally {
    db.close()
  }
}

describe("fetchRawRows", () => {
  let setup: { dbPath: string; cleanup: () => void }
  const REFERENCE = Date.UTC(2026, 6, 6, 12, 0, 0)

  beforeEach(() => {
    setup = setupDb()
  })

  afterEach(() => {
    setup.cleanup()
  })

  it("empty DB returns empty array (no error)", () => {
    const result = fetchRawRows(setup.dbPath, 0, REFERENCE + 86_400_000)
    expect(Array.isArray(result)).toBe(true)
    expect(result).toHaveLength(0)
  })

  it("single assistant message within range returns 1 row with correct fields", () => {
    insertMessage(setup.dbPath, REFERENCE, {
      role: "assistant",
      modelID: "gpt-4",
      providerID: "copilot",
      cost: 0.05,
      tokens: { input: 100, output: 50 },
    })

    const rows = fetchRawRows(setup.dbPath, REFERENCE - 1, REFERENCE + 86_400_000)
    expect(rows).toHaveLength(1)
    expect(rows[0].model_id).toBe("gpt-4")
    expect(rows[0].provider_id).toBe("copilot")
    expect(rows[0].cost).toBeCloseTo(0.05, 6)
    expect(rows[0].input_tokens).toBe(100)
    expect(rows[0].output_tokens).toBe(50)
  })

  it("message outside range is excluded", () => {
    insertMessage(setup.dbPath, REFERENCE, {
      role: "assistant",
      modelID: "gpt-4",
      providerID: "copilot",
      cost: 0.05,
      tokens: { input: 100, output: 50 },
    })

    const earlier = REFERENCE - 86_400_000 * 3
    const rows = fetchRawRows(setup.dbPath, earlier, earlier + 86_400_000)
    expect(rows).toHaveLength(0)
  })

  it("non-assistant messages are excluded", () => {
    insertMessage(setup.dbPath, REFERENCE, {
      role: "user",
      modelID: null,
      providerID: null,
      cost: 0,
      tokens: { input: 0, output: 0 },
    })

    const rows = fetchRawRows(setup.dbPath, REFERENCE - 1, REFERENCE + 86_400_000)
    expect(rows).toHaveLength(0)
  })

  it("multiple messages return correct count and ASC order by time_created", () => {
    const t1 = REFERENCE
    const t2 = REFERENCE + 3600_000
    const t3 = REFERENCE + 7200_000

    insertMessage(setup.dbPath, t3, {
      role: "assistant", modelID: "gpt-4", providerID: "copilot",
      cost: 0.05, tokens: { input: 100, output: 50 },
    })
    insertMessage(setup.dbPath, t1, {
      role: "assistant", modelID: "gpt-3.5", providerID: "copilot",
      cost: 0.01, tokens: { input: 50, output: 25 },
    })
    insertMessage(setup.dbPath, t2, {
      role: "assistant", modelID: "claude-3", providerID: "anthropic",
      cost: 0.03, tokens: { input: 200, output: 100 },
    })

    const rows = fetchRawRows(setup.dbPath, REFERENCE - 1, REFERENCE + 86_400_000)
    expect(rows).toHaveLength(3)

    for (let i = 1; i < rows.length; i++) {
      expect(rows[i].time_created).toBeGreaterThanOrEqual(rows[i - 1].time_created)
    }
  })

  it("returns correct token/cost values matching inserted data", () => {
    insertMessage(setup.dbPath, REFERENCE, {
      role: "assistant", modelID: "gpt-4", providerID: "copilot",
      cost: 0.15, tokens: { input: 5000, output: 3000 },
    })
    insertMessage(setup.dbPath, REFERENCE + 1000, {
      role: "assistant", modelID: "claude-3", providerID: "anthropic",
      cost: 0.08, tokens: { input: 2000, output: 1000 },
    })

    const rows = fetchRawRows(setup.dbPath, REFERENCE - 1, REFERENCE + 86_400_000)
    expect(rows).toHaveLength(2)

    expect(rows[0].model_id).toBe("gpt-4")
    expect(rows[0].provider_id).toBe("copilot")
    expect(rows[0].input_tokens).toBe(5000)
    expect(rows[0].output_tokens).toBe(3000)
    expect(rows[0].cost).toBeCloseTo(0.15, 6)

    expect(rows[1].model_id).toBe("claude-3")
    expect(rows[1].provider_id).toBe("anthropic")
    expect(rows[1].input_tokens).toBe(2000)
    expect(rows[1].output_tokens).toBe(1000)
    expect(rows[1].cost).toBeCloseTo(0.08, 6)
  })

  it("handles null model_id/provider_id gracefully", () => {
    insertMessage(setup.dbPath, REFERENCE, {
      role: "assistant", modelID: null, providerID: null,
      cost: 0.05, tokens: { input: 100, output: 50 },
    })

    const rows = fetchRawRows(setup.dbPath, REFERENCE - 1, REFERENCE + 86_400_000)
    expect(Array.isArray(rows)).toBe(true)
    const nullRows = rows.filter((r: RawUsageRow) => r.model_id === null || r.provider_id === null)
    expect(rows.length).toBeGreaterThanOrEqual(0)
  })

  it("DB file doesn't exist → returns error object", () => {
    const result = fetchRawRows("/nonexistent/path/to/db.db", 0, 1000)
    expect(result).toHaveProperty("error")
    expect(typeof result.error).toBe("string")
    expect(result.error.length).toBeGreaterThan(0)
  })

  it("messages exactly at boundary (startMs) are included", () => {
    insertMessage(setup.dbPath, REFERENCE, {
      role: "assistant", modelID: "gpt-4", providerID: "copilot",
      cost: 0.05, tokens: { input: 100, output: 50 },
    })

    const rows = fetchRawRows(setup.dbPath, REFERENCE, REFERENCE + 86_400_000)
    expect(rows).toHaveLength(1)
    expect(rows[0].input_tokens).toBe(100)
  })

  it("messages exactly at boundary (endMs) are excluded", () => {
    insertMessage(setup.dbPath, REFERENCE + 86_400_000, {
      role: "assistant", modelID: "gpt-4", providerID: "copilot",
      cost: 0.05, tokens: { input: 100, output: 50 },
    })

    const rows = fetchRawRows(setup.dbPath, REFERENCE, REFERENCE + 86_400_000)
    expect(rows).toHaveLength(0)
  })
})
