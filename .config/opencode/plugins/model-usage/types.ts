export interface CopilotConfig {
  modelMultipliers: Record<string, number>
  deprecated: string[]
}

export interface CopilotQuotaInfo {
  percentRemaining: number
  entitlement: number
  remaining: number
  overageCount: number
  overagePermitted: boolean
  unlimited: boolean
  planType: "free" | "paid"
  quotaType: "premium" | "ai_credits"
  tokenBasedBilling: boolean
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

export interface MessagePart {
  type: string
  synthetic?: boolean
}

export interface ModelUsage {
  providerId: string
  modelId: string
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
