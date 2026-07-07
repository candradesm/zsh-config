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
})
