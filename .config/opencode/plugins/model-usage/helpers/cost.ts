import type { Provider } from "@opencode-ai/sdk/v2"

export function splitCost(
  deltaInput: number,
  deltaCacheRead: number,
  deltaOutput: number,
  deltaCost: number,
  modelId: string,
  provider: readonly Provider[]
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

export function getCacheReadPrice(modelId: string, provider: readonly Provider[]): number {
  for (const p of provider) {
    const model = p.models?.[modelId]
    if (model?.cost) {
      return model.cost.cache?.read ?? 0
    }
  }
  return 0
}

/**
 * Calculates the cache hit rate percentage.
 * Returns null when both inputs are 0 to avoid division by zero.
 */
export function calcCacheHitRate(cacheRead: number, nonCachedInput: number): number | null {
  if (cacheRead === 0 && nonCachedInput === 0) {
    return null
  }
  return Math.round((cacheRead / (cacheRead + nonCachedInput)) * 100)
}
