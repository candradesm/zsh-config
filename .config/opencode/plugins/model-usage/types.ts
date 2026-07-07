export interface CopilotQuotaInfo {
  percentRemaining: number
  entitlement: number
  remaining: number
  overageCount: number
  overagePermitted: boolean
  unlimited: boolean
  planType: "free" | "paid"
  quotaType: "premium" | "ai_credits"
}

export interface GoQuotaBar {
  usagePercent: number
  resetInSec: number
}

export interface GoQuotaInfo {
  rolling: GoQuotaBar | null
  weekly: GoQuotaBar | null
  monthly: GoQuotaBar | null
}

export interface ModelUsage {
  providerID: string
  modelID: string
  totalCost: number
  totalInput: number
  totalOutput: number
}

export interface UsageRow {
  model_id: string | null
  provider_id: string | null
  total_cost: number | null
  total_input: number | null
  total_output: number | null
}

export interface UsageData {
  models: ModelUsage[]
  totalInput: number
  totalOutput: number
  totalCost: number
}

// ─── System token analysis (Tier 1-4) ─────────────────────────────────────────

export interface SystemFragment {
  label: string
  tokens: number
}

// Shape persisted by model-usage-server.ts to system-tokens.json
export interface SystemSnapshot {
  /** char/4 estimate of the full assembled system prompt */
  t: number
  /** ms timestamp of last measurement */
  ts: number
  /** per-fragment char/4 breakdown (top-N + "other"); absent on legacy entries */
  fragments?: SystemFragment[]
  /** raw assembled system prompt text; absent on legacy entries */
  rawText?: string
}

export type SystemSource = "baseline DB" | "telemetry (est.)" | "server"

