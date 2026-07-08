import { describe, it, expect, spyOn, mock, afterEach, beforeAll } from "bun:test"
import type { RawUsageRow } from "./db"
import * as fs from "node:fs"

// ─── Module-level state ──────────────────────────────────────────────────────────
// We import command.tsx dynamically so we can mock its JSX dependencies first.
let mod: Awaited<typeof import("./command")>

beforeAll(async () => {
  // Mock the JSX / UI dependencies that command.tsx imports before loading it
  mock.module("@opentui/solid", () => ({}))
  mock.module("@opentui/solid/jsx-dev-runtime", () => ({ jsxDEV: () => null }))
  mock.module("@opentui/solid/jsx-runtime", () => ({ jsx: () => null, jsxs: () => null, Fragment: () => null }))
  mock.module("@opencode-ai/plugin/tui", () => ({}))
  mock.module("solid-js", () => ({
    onMount: (fn: Function) => {},
    onCleanup: (fn: Function) => {},
    createSignal: () => { const fn = (() => {}); return [fn, fn] },
  }))

  mod = await import("./command")
})

// ─── Helpers ─────────────────────────────────────────────────────────────────────

function makeRow(overrides: Partial<RawUsageRow> = {}): RawUsageRow {
  return {
    time_created: Date.now(),
    model_id: "test-model",
    provider_id: "test-provider",
    cost: 0.01,
    input_tokens: 100,
    output_tokens: 50,
    ...overrides,
  }
}

const REF_YEAR = 2026
const REF_MONTH = 6 // July (0-indexed)
const REF_MONTH_START = Date.UTC(REF_YEAR, REF_MONTH, 1)
const REF_MONTH_END = Date.UTC(REF_YEAR, REF_MONTH + 1, 1)
const REF_MID_MONTH = Date.UTC(REF_YEAR, REF_MONTH, 15, 12, 0, 0)

// ─── Suite 1: migrateV2Cache ─────────────────────────────────────────────────────

describe("migrateV2Cache", () => {
  it("normalizes month-level models (providerId → providerID, modelId → modelID)", () => {
    const input = {
      months: {
        "123": {
          models: [
            { providerId: "openai", modelId: "gpt-4", totalCost: 0.1, totalInput: 100, totalOutput: 50 },
          ],
        },
      },
    }
    const result = mod.migrateV2Cache(input)
    const model = result.months["123"].models![0]
    expect(model.providerID).toBe("openai")
    expect(model.modelID).toBe("gpt-4")
    expect((model as any).providerId).toBeUndefined()
    expect((model as any).modelId).toBeUndefined()
  })

  it("normalizes week-level models", () => {
    const input = {
      months: {
        "123": {
          weeks: [
            {
              models: [
                { providerId: "anthropic", modelId: "claude-3", totalCost: 0.2, totalInput: 200, totalOutput: 100 },
              ],
            },
          ],
        },
      },
    }
    const result = mod.migrateV2Cache(input)
    const model = result.months["123"].weeks![0].models![0]
    expect(model.providerID).toBe("anthropic")
    expect(model.modelID).toBe("claude-3")
    expect((model as any).providerId).toBeUndefined()
  })

  it("normalizes day-level models", () => {
    const input = {
      months: {
        "123": {
          days: [
            {
              models: [
                { providerId: "google", modelId: "gemini", totalCost: 0.05, totalInput: 50, totalOutput: 25 },
              ],
            },
          ],
        },
      },
    }
    const result = mod.migrateV2Cache(input)
    const model = result.months["123"].days![0].models![0]
    expect(model.providerID).toBe("google")
    expect(model.modelID).toBe("gemini")
    expect((model as any).providerId).toBeUndefined()
  })

  it("normalizes week-day nested models", () => {
    const input = {
      months: {
        "123": {
          weeks: [
            {
              days: [
                {
                  models: [
                    { providerId: "meta", modelId: "llama", totalCost: 0.03, totalInput: 30, totalOutput: 15 },
                  ],
                },
              ],
            },
          ],
        },
      },
    }
    const result = mod.migrateV2Cache(input)
    const model = result.months["123"].weeks![0].days![0].models![0]
    expect(model.providerID).toBe("meta")
    expect(model.modelID).toBe("llama")
    expect((model as any).providerId).toBeUndefined()
  })

  it("does NOT mutate already-correct models", () => {
    const input = {
      months: {
        "123": {
          models: [
            { providerID: "openai", modelID: "gpt-4", totalCost: 0.1, totalInput: 100, totalOutput: 50 },
          ],
        },
      },
    }
    const result = mod.migrateV2Cache(input)
    const model = result.months["123"].models![0]
    expect(model.providerID).toBe("openai")
    expect(model.modelID).toBe("gpt-4")
    expect(Object.keys(model)).toEqual(["providerID", "modelID", "totalCost", "totalInput", "totalOutput"])
  })

  it("handles missing models (null) without crashing", () => {
    const input = {
      months: {
        "123": { models: null },
        "456": { models: undefined },
        "789": {},
      },
    }
    expect(() => mod.migrateV2Cache(input)).not.toThrow()
    const result = mod.migrateV2Cache(input)
    expect(result.months["123"].models).toBeNull()
    expect(result.months["456"].models).toBeUndefined()
    expect(result.months["789"].models).toBeUndefined()
  })

  it("sets version to CACHE_VERSION", () => {
    const input = { months: {} }
    const result = mod.migrateV2Cache(input)
    expect(result.version).toBe(mod.CACHE_VERSION)
  })
})

// ─── Suite 2: buildHierarchy ──────────────────────────────────────────────────────

describe("buildHierarchy", () => {
  it("month models use providerID/modelID (not providerId/modelId)", () => {
    const rows: RawUsageRow[] = [
      makeRow({
        time_created: REF_MID_MONTH,
        provider_id: "openai",
        model_id: "gpt-4",
        cost: 0.05,
        input_tokens: 200,
        output_tokens: 100,
      }),
    ]
    const result = mod.buildHierarchy(rows, REF_MONTH_START, REF_MONTH_END)
    expect(result.models.length).toBeGreaterThan(0)
    expect(result.models[0].providerID).toBe("openai")
    expect(result.models[0].modelID).toBe("gpt-4")
    expect((result.models[0] as any).providerId).toBeUndefined()
    expect((result.models[0] as any).modelId).toBeUndefined()
  })

  it("week models use providerID/modelID", () => {
    const rows: RawUsageRow[] = [
      makeRow({
        time_created: REF_MID_MONTH,
        provider_id: "anthropic",
        model_id: "claude-3",
        cost: 0.1,
        input_tokens: 300,
        output_tokens: 150,
      }),
    ]
    const result = mod.buildHierarchy(rows, REF_MONTH_START, REF_MONTH_END)
    expect(result.weeks.length).toBeGreaterThan(0)
    const weekWithData = result.weeks.find(w => w.models !== null && w.models.length > 0)
    expect(weekWithData).toBeDefined()
    expect(weekWithData!.models![0].providerID).toBe("anthropic")
    expect(weekWithData!.models![0].modelID).toBe("claude-3")
  })

  it("day models use providerID/modelID", () => {
    const rows: RawUsageRow[] = [
      makeRow({
        time_created: REF_MID_MONTH,
        provider_id: "google",
        model_id: "gemini",
        cost: 0.02,
        input_tokens: 50,
        output_tokens: 25,
      }),
    ]
    const result = mod.buildHierarchy(rows, REF_MONTH_START, REF_MONTH_END)
    expect(result.days.length).toBeGreaterThan(0)
    const dayWithData = result.days.find(d => d.models !== null && d.models.length > 0)
    expect(dayWithData).toBeDefined()
    expect(dayWithData!.models![0].providerID).toBe("google")
    expect(dayWithData!.models![0].modelID).toBe("gemini")
  })

  it("no providerId/modelId old-format keys appear anywhere in model objects", () => {
    const rows: RawUsageRow[] = [
      makeRow({ time_created: REF_MONTH_START + mod.MS_PER_DAY * 1, provider_id: "a", model_id: "m1" }),
      makeRow({ time_created: REF_MONTH_START + mod.MS_PER_DAY * 2, provider_id: "b", model_id: "m2" }),
    ]
    const result = mod.buildHierarchy(rows, REF_MONTH_START, REF_MONTH_END)

    // Recursively collect all ModelUsage-like objects and check them
    function collectModels(obj: any): any[] {
      if (!obj || typeof obj !== "object") return []
      const found: any[] = []
      if (Array.isArray(obj)) {
        for (const item of obj) found.push(...collectModels(item))
      } else {
        if ("providerID" in obj && "modelID" in obj) {
          found.push(obj)
        }
        for (const val of Object.values(obj)) {
          if (val && typeof val === "object") found.push(...collectModels(val))
        }
      }
      return found
    }

    const allModels = collectModels(result)
    expect(allModels.length).toBeGreaterThan(0)

    for (const model of allModels) {
      expect(model.providerID).toBeDefined()
      expect(model.modelID).toBeDefined()
      expect((model as any).providerId).toBeUndefined()
      expect((model as any).modelId).toBeUndefined()
    }
  })

  it("empty rows produce valid structure with correct day count", () => {
    const result = mod.buildHierarchy([], REF_MONTH_START, REF_MONTH_END)
    expect(result.startMs).toBe(REF_MONTH_START)
    expect(result.endMs).toBe(REF_MONTH_END)
    expect(result.inputTokens).toBe(0)
    expect(result.outputTokens).toBe(0)
    expect(result.totalCost).toBe(0)
    // July has 31 days
    expect(result.days.length).toBe(31)
    expect(result.weeks.length).toBeGreaterThanOrEqual(4)
    expect(result.weeks.length).toBeLessThanOrEqual(6)
    for (const day of result.days) {
      expect(day.models).toEqual([])
    }
  })
})

// ─── Suite 3: Debounced save ──────────────────────────────────────────────────────

describe("Debounced save", () => {
  afterEach(() => {
    // Clear any leftover timer to avoid cross-test pollution
    mod.flushDiskSave()
  })

  it("scheduleDiskSave debounces (only one setTimeout for two calls)", () => {
    const setTimeoutSpy = spyOn(globalThis, "setTimeout").mockImplementation(() => 42 as any)
    const writeSpy = spyOn(fs, "writeFileSync").mockImplementation(() => {})

    mod.scheduleDiskSave()
    mod.scheduleDiskSave()

    expect(setTimeoutSpy).toHaveBeenCalledTimes(1)
    expect(writeSpy).toHaveBeenCalledTimes(0)

    setTimeoutSpy.mockRestore()
    writeSpy.mockRestore()
  })

  it("flushDiskSave writes immediately", () => {
    const setTimeoutSpy = spyOn(globalThis, "setTimeout").mockImplementation(() => 42 as any)
    const writeSpy = spyOn(fs, "writeFileSync").mockImplementation(() => {})

    mod.scheduleDiskSave()
    mod.flushDiskSave()

    expect(writeSpy).toHaveBeenCalledTimes(1)

    setTimeoutSpy.mockRestore()
    writeSpy.mockRestore()
  })

  it("flushDiskSave cancels pending timer", () => {
    const setTimeoutSpy = spyOn(globalThis, "setTimeout").mockImplementation(() => 42 as any)
    const clearTimeoutSpy = spyOn(globalThis, "clearTimeout").mockImplementation(() => {})
    const writeSpy = spyOn(fs, "writeFileSync").mockImplementation(() => {})

    mod.scheduleDiskSave()
    mod.flushDiskSave()

    expect(clearTimeoutSpy).toHaveBeenCalledWith(42)
    expect(writeSpy).toHaveBeenCalledTimes(1)

    setTimeoutSpy.mockRestore()
    clearTimeoutSpy.mockRestore()
    writeSpy.mockRestore()
  })
})

// ─── Suite 4: computeUsageDataFromRows ─────────────────────────────────────────

describe("computeUsageDataFromRows", () => {
  it("aggregates rows by provider/model", () => {
    const rows = [
      makeRow({ provider_id: "openai", model_id: "gpt-4", input_tokens: 100, output_tokens: 50, cost: 0.01 }),
      makeRow({ provider_id: "openai", model_id: "gpt-4", input_tokens: 200, output_tokens: 100, cost: 0.02 }),
      makeRow({ provider_id: "anthropic", model_id: "claude-3", input_tokens: 300, output_tokens: 150, cost: 0.03 }),
    ]
    const result = mod.computeUsageDataFromRows(rows)
    expect(result.models).toHaveLength(2)
    const openai = result.models.find(m => m.providerID === "openai" && m.modelID === "gpt-4")!
    expect(openai.totalInput).toBe(300)
    expect(openai.totalOutput).toBe(150)
    expect(openai.totalCost).toBeCloseTo(0.03)
    const anthropic = result.models.find(m => m.providerID === "anthropic" && m.modelID === "claude-3")!
    expect(anthropic.totalInput).toBe(300)
    expect(anthropic.totalOutput).toBe(150)
    expect(anthropic.totalCost).toBeCloseTo(0.03)
    expect(result.totalInput).toBe(600)
    expect(result.totalOutput).toBe(300)
    expect(result.totalCost).toBeCloseTo(0.06)
  })

  it("skips rows without provider_id", () => {
    const rows = [
      makeRow({ provider_id: null, model_id: "gpt-4", input_tokens: 100, output_tokens: 50 }),
      makeRow({ provider_id: "openai", model_id: "gpt-4", input_tokens: 200, output_tokens: 100 }),
    ]
    const result = mod.computeUsageDataFromRows(rows)
    expect(result.models).toHaveLength(1)
    expect(result.models[0].totalInput).toBe(200)
    expect(result.models[0].totalOutput).toBe(100)
    expect(result.totalInput).toBe(200)
    expect(result.totalOutput).toBe(100)
  })

  it("skips rows without model_id", () => {
    const rows = [
      makeRow({ model_id: null, provider_id: "openai", input_tokens: 100, output_tokens: 50 }),
      makeRow({ model_id: "gpt-4", provider_id: "openai", input_tokens: 200, output_tokens: 100 }),
    ]
    const result = mod.computeUsageDataFromRows(rows)
    expect(result.models).toHaveLength(1)
    expect(result.models[0].totalInput).toBe(200)
    expect(result.models[0].totalOutput).toBe(100)
    expect(result.totalInput).toBe(200)
    expect(result.totalOutput).toBe(100)
  })

  it("sorts by total tokens descending", () => {
    const rows = [
      makeRow({ provider_id: "a", model_id: "m1", input_tokens: 100, output_tokens: 50 }),
      makeRow({ provider_id: "b", model_id: "m2", input_tokens: 300, output_tokens: 200 }),
      makeRow({ provider_id: "c", model_id: "m3", input_tokens: 50, output_tokens: 25 }),
    ]
    const result = mod.computeUsageDataFromRows(rows)
    expect(result.models).toHaveLength(3)
    const totals = result.models.map(m => m.totalInput + m.totalOutput)
    expect(totals[0]).toBe(500)
    expect(totals[1]).toBe(150)
    expect(totals[2]).toBe(75)
  })

  it("caps at 10 models", () => {
    const rows = Array.from({ length: 12 }, (_, i) =>
      makeRow({ provider_id: `p${i}`, model_id: `m${i}` })
    )
    const result = mod.computeUsageDataFromRows(rows)
    expect(result.models).toHaveLength(10)
  })

  it("handles empty input", () => {
    const result = mod.computeUsageDataFromRows([])
    expect(result.models).toEqual([])
    expect(result.totalInput).toBe(0)
    expect(result.totalOutput).toBe(0)
    expect(result.totalCost).toBe(0)
  })

  it("handles negative values with Math.max(0, ...)", () => {
    const rows = [
      makeRow({ provider_id: "openai", model_id: "gpt-4", input_tokens: -50, output_tokens: -25, cost: -0.01 }),
    ]
    const result = mod.computeUsageDataFromRows(rows)
    expect(result.models).toHaveLength(1)
    expect(result.models[0].totalInput).toBe(0)
    expect(result.models[0].totalOutput).toBe(0)
    expect(result.models[0].totalCost).toBe(0)
    expect(result.totalInput).toBe(0)
    expect(result.totalOutput).toBe(0)
    expect(result.totalCost).toBe(0)
  })
})

// ─── Suite 5: updateMonthCache ─────────────────────────────────────────────────

describe("updateMonthCache", () => {
  it("computes percent change vs previous month", () => {
    const msJan = Date.UTC(2010, 0, 1)
    const msFeb = Date.UTC(2010, 1, 1)
    const periodJan = {
      startMs: msJan,
      endMs: msFeb,
      inputTokens: 800,
      outputTokens: 200,
      totalCost: 0.1,
      change: null as number | null,
      lastUpdated: Date.now(),
      weeks: null,
      days: null,
      models: null,
    }
    const periodFeb = {
      startMs: msFeb,
      endMs: Date.UTC(2010, 2, 1),
      inputTokens: 1000,
      outputTokens: 500,
      totalCost: 0.15,
      change: null as number | null,
      lastUpdated: Date.now(),
      weeks: null,
      days: null,
      models: null,
    }
    mod.updateMonthCache(periodJan)
    mod.updateMonthCache(periodFeb)
    expect(periodFeb.change).toBe(50) // (1500-1000)/1000*100 = 50
  })

  it("sets change to null when previous month not cached", () => {
    const period = {
      startMs: Date.UTC(2020, 5, 1),
      endMs: Date.UTC(2020, 6, 1),
      inputTokens: 500,
      outputTokens: 250,
      totalCost: 0.05,
      change: null as number | null,
      lastUpdated: Date.now(),
      weeks: null,
      days: null,
      models: null,
    }
    mod.updateMonthCache(period)
    expect(period.change).toBeNull()
  })

  it("computes week cross-month change", () => {
    const prevWeek = {
      startMs: Date.UTC(2030, 2, 25),
      endMs: Date.UTC(2030, 3, 1),
      inputTokens: 600,
      outputTokens: 300,
      totalCost: 0.09,
      change: 10 as number | null,
      lastUpdated: Date.now(),
      weeks: null,
      days: [],
      models: [],
    }
    const prevPeriod = {
      startMs: Date.UTC(2030, 2, 1),
      endMs: Date.UTC(2030, 3, 1),
      inputTokens: 1000,
      outputTokens: 500,
      totalCost: 0.15,
      change: null as number | null,
      lastUpdated: Date.now(),
      weeks: [prevWeek],
      days: [],
      models: [],
    }
    const currFirstWeek = {
      startMs: Date.UTC(2030, 3, 1),
      endMs: Date.UTC(2030, 3, 8),
      inputTokens: 900,
      outputTokens: 450,
      totalCost: 0.12,
      change: null as number | null,
      lastUpdated: Date.now(),
      weeks: null,
      days: [],
      models: [],
    }
    const currPeriod = {
      startMs: Date.UTC(2030, 3, 1),
      endMs: Date.UTC(2030, 4, 1),
      inputTokens: 1500,
      outputTokens: 750,
      totalCost: 0.21,
      change: null as number | null,
      lastUpdated: Date.now(),
      weeks: [currFirstWeek],
      days: [],
      models: [],
    }
    mod.updateMonthCache(prevPeriod)
    mod.updateMonthCache(currPeriod)
    expect(currFirstWeek.change).toBe(50) // (1350-900)/900*100 = 50
  })
})

// ─── Suite 6: migrateV2Cache edge cases ────────────────────────────────────────

describe("migrateV2Cache edge cases", () => {
  it("normalizes mixed field names (providerId and providerID)", () => {
    const input = {
      months: {
        "1": {
          models: [
            { providerId: "openai", modelID: "gpt-4", totalCost: 0.1, totalInput: 100, totalOutput: 50 },
            { providerID: "anthropic", modelId: "claude-3", totalCost: 0.2, totalInput: 200, totalOutput: 100 },
          ],
        },
      },
    }
    const result = mod.migrateV2Cache(input)
    const models = result.months["1"].models!
    expect(models).toHaveLength(2)
    for (const m of models) {
      expect(m.providerID).toBeDefined()
      expect(m.modelID).toBeDefined()
      expect((m as any).providerId).toBeUndefined()
      expect((m as any).modelId).toBeUndefined()
    }
    expect(models[0].providerID).toBe("openai")
    expect(models[0].modelID).toBe("gpt-4")
    expect(models[1].providerID).toBe("anthropic")
    expect(models[1].modelID).toBe("claude-3")
  })

  it("handles empty months object", () => {
    const result = mod.migrateV2Cache({ months: {} })
    expect(result.version).toBe(mod.CACHE_VERSION)
    expect(result.months).toEqual({})
  })

  it("handles month with weeks but no days without crashing", () => {
    const input = {
      months: {
        "1": {
          weeks: [
            {
              models: [
                { providerId: "openai", modelId: "gpt-4", totalCost: 0.1, totalInput: 100, totalOutput: 50 },
              ],
            },
          ],
        },
      },
    }
    expect(() => mod.migrateV2Cache(input)).not.toThrow()
    const result = mod.migrateV2Cache(input)
    const model = result.months["1"].weeks![0].models![0]
    expect(model.providerID).toBe("openai")
    expect(model.modelID).toBe("gpt-4")
    expect((model as any).providerId).toBeUndefined()
  })
})

// ─── Suite 7: buildHierarchy edge cases ────────────────────────────────────────

describe("buildHierarchy edge cases", () => {
  it("rows at month boundaries are correctly bucketed into correct days", () => {
    const rows = [
      makeRow({ time_created: REF_MONTH_START }),
      makeRow({ time_created: REF_MONTH_END - 1 }),
    ]
    const result = mod.buildHierarchy(rows, REF_MONTH_START, REF_MONTH_END)
    expect(result.days).toHaveLength(31)
    const daysWithData = result.days.filter(d => d.inputTokens > 0)
    expect(daysWithData).toHaveLength(2)
    // First day of month
    expect(result.days[0].inputTokens).toBe(100)
    expect(result.days[0].outputTokens).toBe(50)
    // Last day of month
    expect(result.days[30].inputTokens).toBe(100)
    expect(result.days[30].outputTokens).toBe(50)
  })

  it("single row produces correct structure with rest days as zeros", () => {
    const rows = [makeRow({ time_created: REF_MID_MONTH })]
    const result = mod.buildHierarchy(rows, REF_MONTH_START, REF_MONTH_END)
    expect(result.days).toHaveLength(31)

    const dayWithData = result.days.find(d => d.inputTokens > 0)!
    expect(dayWithData.inputTokens).toBe(100)
    expect(dayWithData.outputTokens).toBe(50)
    expect(dayWithData.models).toHaveLength(1)
    expect(dayWithData.models![0].providerID).toBe("test-provider")
    expect(dayWithData.models![0].modelID).toBe("test-model")
    expect(dayWithData.models![0].totalInput).toBe(100)
    expect(dayWithData.models![0].totalOutput).toBe(50)

    const emptyDays = result.days.filter(d => d.inputTokens === 0)
    expect(emptyDays).toHaveLength(30)
    for (const day of emptyDays) {
      expect(day.models).toEqual([])
    }
  })
})
