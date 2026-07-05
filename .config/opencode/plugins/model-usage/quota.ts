import { existsSync, readFileSync } from "node:fs"
import { homedir } from "node:os"
import type { CopilotQuotaInfo, GoQuotaInfo } from "./types"
import { log } from "./helpers"

export function getGoAuth(): { type: "bearer" | "cookie"; value: string } | null {
  // Cookie auth first — required for fetching the web console page
  const cookie = process.env.OPENCODE_GO_AUTH_COOKIE
  if (cookie) return { type: "cookie", value: cookie }

  // Bearer token fallback (inference key, may not work for web page)
  try {
    const authPath = `${homedir()}/.local/share/opencode/auth.json`
    if (existsSync(authPath)) {
      const raw = readFileSync(authPath, "utf8")
      const auth = JSON.parse(raw)
      const key = auth?.["opencode-go"]?.key
      if (key && auth["opencode-go"]?.type === "api") {
        return { type: "bearer", value: key }
      }
    }
  } catch {
    // ignore
  }

  const apiKey = process.env.OPENCODE_GO_API_KEY
  if (apiKey) return { type: "bearer", value: apiKey }

  return null
}

export async function fetchGoQuota(): Promise<GoQuotaInfo | null> {
  const workspaceId = process.env.OPENCODE_GO_WORKSPACE_ID
  if (!workspaceId) return null

  const auth = getGoAuth()
  if (!auth) return null

  const patterns = {
    rolling: /rollingUsage:\$R\[\d+\]=(\{[^}]+\})/,
    weekly: /weeklyUsage:\$R\[\d+\]=(\{[^}]+\})/,
    monthly: /monthlyUsage:\$R\[\d+\]=(\{[^}]+\})/,
  }

  try {
    const headers: Record<string, string> = {
      "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36",
      Accept: "text/html,application/xhtml+xml",
    }
    if (auth.type === "bearer") {
      headers["Authorization"] = `Bearer ${auth.value}`
    } else {
      headers["Cookie"] = `auth=${auth.value}`
    }

    const response = await fetch(
      `https://opencode.ai/workspace/${encodeURIComponent(workspaceId)}/go`,
      { headers },
    )

    if (!response.ok) return null

    const html = await response.text()
    const usage: GoQuotaInfo = { rolling: null, weekly: null, monthly: null }

    for (const [key, pattern] of Object.entries(patterns)) {
      const match = html.match(pattern)
      if (match) {
        try {
          const jsonStr = match[1].replace(/([{,]\s*)([a-zA-Z_][a-zA-Z0-9_]*)(\s*:)/g, '$1"$2"$3')
          usage[key as keyof GoQuotaInfo] = JSON.parse(jsonStr)
        } catch {
          // ignore individual parse failures
        }
      }
    }

    return usage
  } catch {
    return null
  }
}

export async function fetchQuotaInfo(token: string): Promise<CopilotQuotaInfo | null> {
  try {
    log("fetchQuotaInfo: fetching quota from github API")
    const response = await fetch("https://api.github.com/copilot_internal/user", {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/json",
        "X-GitHub-Api-Version": "2026-06-01",
        "User-Agent": "opencode-copilot-usage-plugin",
      },
    })

    log("fetchQuotaInfo: response status:", response.status)
    if (!response.ok) {
      log("fetchQuotaInfo: response not ok, body:", await response.text().catch(() => "failed to read"))
      return null
    }

    const data = await response.json()
    log("fetchQuotaInfo: copilot_plan:", data?.copilot_plan)

    // Paid plan: try premium_models first, fall back to premium_interactions.
    // AI Credits detection: check snapshot.token_based_billing or root token_based_billing flag
    // (GitHub migrated from count-based "premium requests" to token-based "AI Credits").
    const snapshot = data?.quota_snapshots?.premium_models ?? data?.quota_snapshots?.premium_interactions
    if (snapshot) {
      return {
        percentRemaining: snapshot.percent_remaining ?? 100,
        entitlement: snapshot.entitlement ?? 0,
        remaining: snapshot.remaining ?? 0,
        overageCount: snapshot.overage_count ?? 0,
        overagePermitted: snapshot.overage_permitted ?? false,
        unlimited: snapshot.unlimited ?? false,
        planType: "paid",
        quotaType: (data?.quota_snapshots?.premium_models || snapshot.token_based_billing || data?.token_based_billing) ? "ai_credits" : "premium",
      }
    }

    // Free plan: limited_user_quotas + monthly_quotas
    const chatRemaining = data?.limited_user_quotas?.chat
    const chatMonthly = data?.monthly_quotas?.chat
    if (chatRemaining != null && chatMonthly != null && chatMonthly > 0) {
      const percentRemaining = Math.round((chatRemaining / chatMonthly) * 1000) / 10
      log("fetchQuotaInfo: free plan, chat remaining:", chatRemaining, "/", chatMonthly, "=", percentRemaining.toFixed(1) + "%")
      return {
        percentRemaining,
        entitlement: chatMonthly,
        remaining: chatRemaining,
        overageCount: 0,
        overagePermitted: false,
        unlimited: false,
        planType: "free",
        quotaType: "premium",
      }
    }

    log("fetchQuotaInfo: no quota data found")
    return null
  } catch (err) {
    log("fetchQuotaInfo: error:", String(err))
    return null
  }
}
