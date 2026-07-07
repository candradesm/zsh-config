import { describe, expect, it } from "bun:test"
import { aggregateModelStats } from "./models"
import type { ModelUsageRecord, ModelStat } from "./models"

// ─── aggregateModelStats ─────────────────────────────────────────────────────

describe("aggregateModelStats", () => {
  it("returns empty array for empty input", () => {
    expect(aggregateModelStats([])).toEqual([])
  })

  it("handles a single record correctly", () => {
    const records: ModelUsageRecord[] = [
      {
        providerID: "anthropic",
        modelID: "claude-3-5-sonnet",
        inputTokens: 100,
        outputTokens: 200,
        cacheRead: 50,
        cacheWrite: 10,
        cost: 0.0015,
        visibleOutputTokens: 150,
      },
    ]

    const result = aggregateModelStats(records)
    expect(result).toEqual([
      {
        providerID: "anthropic",
        modelID: "claude-3-5-sonnet",
        msgCount: 1,
        inputTokens: 100,
        outputTokens: 200,
        cacheRead: 50,
        cacheWrite: 10,
        cost: 0.0015,
        visibleOutputTokens: 150,
      },
    ])
  })

  it("correctly aggregates multiple records for the same provider/model pair", () => {
    const records: ModelUsageRecord[] = [
      {
        providerID: "anthropic",
        modelID: "claude-3-5-sonnet",
        inputTokens: 100,
        outputTokens: 200,
        cacheRead: 50,
        cacheWrite: 10,
        cost: 0.0015,
        visibleOutputTokens: 80,
      },
      {
        providerID: "anthropic",
        modelID: "claude-3-5-sonnet",
        inputTokens: 200,
        outputTokens: 300,
        cacheRead: 20,
        cacheWrite: 0,
        cost: 0.002,
        visibleOutputTokens: 120,
      },
      {
        providerID: "anthropic",
        modelID: "claude-3-5-sonnet",
        inputTokens: 50,
        outputTokens: 50,
        cacheRead: 0,
        cacheWrite: 0,
        cost: 0.0005,
        visibleOutputTokens: 30,
      },
    ]

    const result = aggregateModelStats(records)
    expect(result).toEqual([
      {
        providerID: "anthropic",
        modelID: "claude-3-5-sonnet",
        msgCount: 3,
        inputTokens: 350,
        outputTokens: 550,
        cacheRead: 70,
        cacheWrite: 10,
        cost: 0.004,
        visibleOutputTokens: 230,
      },
    ])
  })

  it("correctly groups records with different providerID or modelID", () => {
    const records: ModelUsageRecord[] = [
      {
        providerID: "anthropic",
        modelID: "claude-3-5-sonnet",
        inputTokens: 100,
        outputTokens: 200,
        cacheRead: 50,
        cacheWrite: 10,
        cost: 0.0015,
        visibleOutputTokens: 150,
      },
      {
        providerID: "openai",
        modelID: "gpt-4o",
        inputTokens: 300,
        outputTokens: 400,
        cacheRead: 0,
        cacheWrite: 0,
        cost: 0.005,
        visibleOutputTokens: 250,
      },
      {
        providerID: "openai",
        modelID: "gpt-4o-mini",
        inputTokens: 10,
        outputTokens: 20,
        cacheRead: 0,
        cacheWrite: 0,
        cost: 0.0001,
        visibleOutputTokens: 15,
      },
    ]

    const result = aggregateModelStats(records)
    expect(result.length).toBe(3)

    const anthropicSonnet = result.find(r => r.providerID === "anthropic" && r.modelID === "claude-3-5-sonnet")
    const openaiGpt4o = result.find(r => r.providerID === "openai" && r.modelID === "gpt-4o")
    const openaiGpt4oMini = result.find(r => r.providerID === "openai" && r.modelID === "gpt-4o-mini")

    expect(anthropicSonnet).toEqual({
      providerID: "anthropic",
      modelID: "claude-3-5-sonnet",
      msgCount: 1,
      inputTokens: 100,
      outputTokens: 200,
      cacheRead: 50,
      cacheWrite: 10,
      cost: 0.0015,
      visibleOutputTokens: 150,
    })

    expect(openaiGpt4o).toEqual({
      providerID: "openai",
      modelID: "gpt-4o",
      msgCount: 1,
      inputTokens: 300,
      outputTokens: 400,
      cacheRead: 0,
      cacheWrite: 0,
      cost: 0.005,
      visibleOutputTokens: 250,
    })

    expect(openaiGpt4oMini).toEqual({
      providerID: "openai",
      modelID: "gpt-4o-mini",
      msgCount: 1,
      inputTokens: 10,
      outputTokens: 20,
      cacheRead: 0,
      cacheWrite: 0,
      cost: 0.0001,
      visibleOutputTokens: 15,
    })
  })

  it("retains zero-value records without dropping them", () => {
    const records: ModelUsageRecord[] = [
      {
        providerID: "copilot",
        modelID: "free-model",
        inputTokens: 0,
        outputTokens: 0,
        cacheRead: 0,
        cacheWrite: 0,
        cost: 0,
        visibleOutputTokens: 0,
      },
    ]

    const result = aggregateModelStats(records)
    expect(result).toEqual([
      {
        providerID: "copilot",
        modelID: "free-model",
        msgCount: 1,
        inputTokens: 0,
        outputTokens: 0,
        cacheRead: 0,
        cacheWrite: 0,
        cost: 0,
        visibleOutputTokens: 0,
      },
    ])
  })

  it("distinguishes same modelID with different providerID", () => {
    const records: ModelUsageRecord[] = [
      {
        providerID: "anthropic",
        modelID: "claude-3-5-sonnet",
        inputTokens: 100,
        outputTokens: 200,
        cacheRead: 50,
        cacheWrite: 10,
        cost: 0.0015,
        visibleOutputTokens: 120,
      },
      {
        providerID: "openrouter",
        modelID: "claude-3-5-sonnet",
        inputTokens: 200,
        outputTokens: 400,
        cacheRead: 100,
        cacheWrite: 20,
        cost: 0.003,
        visibleOutputTokens: 240,
      },
    ]

    const result = aggregateModelStats(records)
    expect(result.length).toBe(2)

    const anthropic = result.find(r => r.providerID === "anthropic")
    const openrouter = result.find(r => r.providerID === "openrouter")

    expect(anthropic?.msgCount).toBe(1)
    expect(anthropic?.inputTokens).toBe(100)
    expect(anthropic?.visibleOutputTokens).toBe(120)
    expect(openrouter?.msgCount).toBe(1)
    expect(openrouter?.inputTokens).toBe(200)
    expect(openrouter?.visibleOutputTokens).toBe(240)
  })

  describe("handling lastCallRawPromptTokens", () => {
    it("handles a single record correctly", () => {
      const records: ModelUsageRecord[] = [
        {
          providerID: "anthropic",
          modelID: "claude-3-5-sonnet",
          inputTokens: 100,
          outputTokens: 200,
          cacheRead: 50,
          cacheWrite: 10,
          cost: 0.0015,
          visibleOutputTokens: 150,
          lastCallRawPromptTokens: 25000,
        },
      ]

      const result = aggregateModelStats(records)
      expect(result[0].lastCallRawPromptTokens).toBe(25000)
    })

    it("aggregates multiple records and asserts that lastCallRawPromptTokens equals the LAST record's value in array order", () => {
      const records: ModelUsageRecord[] = [
        {
          providerID: "anthropic",
          modelID: "claude-3-5-sonnet",
          inputTokens: 100,
          outputTokens: 200,
          cacheRead: 50,
          cacheWrite: 10,
          cost: 0.0015,
          visibleOutputTokens: 150,
          lastCallRawPromptTokens: 15000, // first
        },
        {
          providerID: "anthropic",
          modelID: "claude-3-5-sonnet",
          inputTokens: 150,
          outputTokens: 250,
          cacheRead: 60,
          cacheWrite: 20,
          cost: 0.002,
          visibleOutputTokens: 160,
          lastCallRawPromptTokens: 45000, // max, but not last
        },
        {
          providerID: "anthropic",
          modelID: "claude-3-5-sonnet",
          inputTokens: 200,
          outputTokens: 300,
          cacheRead: 70,
          cacheWrite: 30,
          cost: 0.0025,
          visibleOutputTokens: 170,
          lastCallRawPromptTokens: 30000, // last (wins!)
        },
      ]

      const result = aggregateModelStats(records)
      expect(result[0].lastCallRawPromptTokens).toBe(30000)
    })

    it("handles cases where lastCallRawPromptTokens is undefined / missing on some entries with sensible fallback behavior", () => {
      // Case A: First record is defined, second is undefined.
      // Expect lastCallRawPromptTokens to keep the most recently seen defined value.
      const recordsA: ModelUsageRecord[] = [
        {
          providerID: "anthropic",
          modelID: "claude-3-5-sonnet",
          inputTokens: 100,
          outputTokens: 200,
          cacheRead: 50,
          cacheWrite: 10,
          cost: 0.0015,
          visibleOutputTokens: 150,
          lastCallRawPromptTokens: 22000,
        },
        {
          providerID: "anthropic",
          modelID: "claude-3-5-sonnet",
          inputTokens: 150,
          outputTokens: 250,
          cacheRead: 60,
          cacheWrite: 20,
          cost: 0.002,
          visibleOutputTokens: 160,
          lastCallRawPromptTokens: undefined, // should not overwrite 22000 per implementation
        },
      ]

      const resultA = aggregateModelStats(recordsA)
      expect(resultA[0].lastCallRawPromptTokens).toBe(22000)

      // Case B: First record is undefined, second is defined.
      // Expect lastCallRawPromptTokens to be the second record's defined value.
      const recordsB: ModelUsageRecord[] = [
        {
          providerID: "anthropic",
          modelID: "claude-3-5-sonnet",
          inputTokens: 100,
          outputTokens: 200,
          cacheRead: 50,
          cacheWrite: 10,
          cost: 0.0015,
          visibleOutputTokens: 150,
          lastCallRawPromptTokens: undefined,
        },
        {
          providerID: "anthropic",
          modelID: "claude-3-5-sonnet",
          inputTokens: 150,
          outputTokens: 250,
          cacheRead: 60,
          cacheWrite: 20,
          cost: 0.002,
          visibleOutputTokens: 160,
          lastCallRawPromptTokens: 33000,
        },
      ]

      const resultB = aggregateModelStats(recordsB)
      expect(resultB[0].lastCallRawPromptTokens).toBe(33000)

      // Case C: Both records are undefined.
      // Expect lastCallRawPromptTokens to be undefined.
      const recordsC: ModelUsageRecord[] = [
        {
          providerID: "anthropic",
          modelID: "claude-3-5-sonnet",
          inputTokens: 100,
          outputTokens: 200,
          cacheRead: 50,
          cacheWrite: 10,
          cost: 0.0015,
          visibleOutputTokens: 150,
        },
        {
          providerID: "anthropic",
          modelID: "claude-3-5-sonnet",
          inputTokens: 150,
          outputTokens: 250,
          cacheRead: 60,
          cacheWrite: 20,
          cost: 0.002,
          visibleOutputTokens: 160,
        },
      ]

      const resultC = aggregateModelStats(recordsC)
      expect(resultC[0].lastCallRawPromptTokens).toBeUndefined()
    })

    it("confirms other fields (inputTokens, outputTokens, cost, cacheRead, cacheWrite, visibleOutputTokens) still sum correctly alongside this new non-summed field", () => {
      const records: ModelUsageRecord[] = [
        {
          providerID: "anthropic",
          modelID: "claude-3-5-sonnet",
          inputTokens: 100,
          outputTokens: 200,
          cacheRead: 50,
          cacheWrite: 10,
          cost: 0.0015,
          visibleOutputTokens: 150,
          lastCallRawPromptTokens: 20000,
        },
        {
          providerID: "anthropic",
          modelID: "claude-3-5-sonnet",
          inputTokens: 150,
          outputTokens: 250,
          cacheRead: 60,
          cacheWrite: 20,
          cost: 0.002,
          visibleOutputTokens: 160,
          lastCallRawPromptTokens: 35000,
        },
      ]

      const result = aggregateModelStats(records)
      expect(result[0]).toEqual({
        providerID: "anthropic",
        modelID: "claude-3-5-sonnet",
        msgCount: 2,
        inputTokens: 250, // 100 + 150
        outputTokens: 450, // 200 + 250
        cacheRead: 110, // 50 + 60
        cacheWrite: 30, // 10 + 20
        cost: 0.0035, // 0.0015 + 0.002
        visibleOutputTokens: 310, // 150 + 160
        lastCallRawPromptTokens: 35000, // last wins!
      })
    })

    it("preserves last real positive value when the last record has 0 or undefined lastCallRawPromptTokens", () => {
      const records: ModelUsageRecord[] = [
        {
          providerID: "anthropic",
          modelID: "claude-3-5-sonnet",
          inputTokens: 100,
          outputTokens: 200,
          cacheRead: 50,
          cacheWrite: 10,
          cost: 0.0015,
          visibleOutputTokens: 150,
          lastCallRawPromptTokens: 25000,
        },
        {
          providerID: "anthropic",
          modelID: "claude-3-5-sonnet",
          inputTokens: 0,
          outputTokens: 0,
          cacheRead: 0,
          cacheWrite: 0,
          cost: 0,
          visibleOutputTokens: 0,
          lastCallRawPromptTokens: 0, // degenerate last call
        },
      ]

      const result = aggregateModelStats(records)
      expect(result[0].lastCallRawPromptTokens).toBe(25000)

      // Test with undefined as well
      const recordsWithUndefined: ModelUsageRecord[] = [
        {
          providerID: "anthropic",
          modelID: "claude-3-5-sonnet",
          inputTokens: 100,
          outputTokens: 200,
          cacheRead: 50,
          cacheWrite: 10,
          cost: 0.0015,
          visibleOutputTokens: 150,
          lastCallRawPromptTokens: 25000,
        },
        {
          providerID: "anthropic",
          modelID: "claude-3-5-sonnet",
          inputTokens: 0,
          outputTokens: 0,
          cacheRead: 0,
          cacheWrite: 0,
          cost: 0,
          visibleOutputTokens: 0,
          lastCallRawPromptTokens: undefined, // degenerate last call
        },
      ]

      const resultWithUndefined = aggregateModelStats(recordsWithUndefined)
      expect(resultWithUndefined[0].lastCallRawPromptTokens).toBe(25000)
    })

    it("ensures the chronologically last non-zero value wins when a middle record has 0 lastCallRawPromptTokens", () => {
      const records: ModelUsageRecord[] = [
        {
          providerID: "anthropic",
          modelID: "claude-3-5-sonnet",
          inputTokens: 100,
          outputTokens: 200,
          cacheRead: 50,
          cacheWrite: 10,
          cost: 0.0015,
          visibleOutputTokens: 150,
          lastCallRawPromptTokens: 15000, // first real
        },
        {
          providerID: "anthropic",
          modelID: "claude-3-5-sonnet",
          inputTokens: 0,
          outputTokens: 0,
          cacheRead: 0,
          cacheWrite: 0,
          cost: 0,
          visibleOutputTokens: 0,
          lastCallRawPromptTokens: 0, // middle 0
        },
        {
          providerID: "anthropic",
          modelID: "claude-3-5-sonnet",
          inputTokens: 150,
          outputTokens: 250,
          cacheRead: 60,
          cacheWrite: 20,
          cost: 0.002,
          visibleOutputTokens: 160,
          lastCallRawPromptTokens: 30000, // last real (wins)
        },
      ]

      const result = aggregateModelStats(records)
      expect(result[0].lastCallRawPromptTokens).toBe(30000)
    })

    it("retains 0 lastCallRawPromptTokens when it is the only record for a model", () => {
      const records: ModelUsageRecord[] = [
        {
          providerID: "anthropic",
          modelID: "claude-3-5-sonnet",
          inputTokens: 0,
          outputTokens: 0,
          cacheRead: 0,
          cacheWrite: 0,
          cost: 0,
          visibleOutputTokens: 0,
          lastCallRawPromptTokens: 0,
        },
      ]

      const result = aggregateModelStats(records)
      expect(result[0].lastCallRawPromptTokens).toBe(0)
    })

    it("verifies other summed fields aggregate correctly regardless of the 0/undefined lastCallRawPromptTokens guard", () => {
      const records: ModelUsageRecord[] = [
        {
          providerID: "anthropic",
          modelID: "claude-3-5-sonnet",
          inputTokens: 100,
          outputTokens: 200,
          cacheRead: 50,
          cacheWrite: 10,
          cost: 0.0015,
          visibleOutputTokens: 150,
          lastCallRawPromptTokens: 25000,
        },
        {
          providerID: "anthropic",
          modelID: "claude-3-5-sonnet",
          inputTokens: 50,
          outputTokens: 100,
          cacheRead: 20,
          cacheWrite: 5,
          cost: 0.0005,
          visibleOutputTokens: 80,
          lastCallRawPromptTokens: 0, // should be ignored for raw prompt but others should sum
        },
      ]

      const result = aggregateModelStats(records)
      expect(result[0]).toEqual({
        providerID: "anthropic",
        modelID: "claude-3-5-sonnet",
        msgCount: 2,
        inputTokens: 150,
        outputTokens: 300,
        cacheRead: 70,
        cacheWrite: 15,
        cost: 0.0020,
        visibleOutputTokens: 230,
        lastCallRawPromptTokens: 25000, // retains prior value
      })
    })
  })
})
