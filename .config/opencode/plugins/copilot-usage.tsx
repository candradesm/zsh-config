/** @jsxImportSource @opentui/solid */
import type { TuiPlugin, TuiPluginModule, TuiPluginApi } from "@opencode-ai/plugin/tui"
import type { EventMessageUpdated } from "@opencode-ai/sdk/v2"
import { createSignal, createEffect, createMemo, onCleanup } from "solid-js"
import { mkdirSync, appendFileSync } from "node:fs"

const QUOTA_REFRESH_MS = 5 * 60 * 1000
const MAX_POLL_ATTEMPTS = 30
const PLUGIN_VERSION = "v6-quota-fixed"

interface CopilotConfig {
  maxPremiumRequests: number
  modelMultipliers: Record<string, number>
}

interface CopilotQuotaInfo {
  percentRemaining: number
  entitlement: number
  overageCount: number
  overagePermitted: boolean
  unlimited: boolean
}

const DEBUG = process.env.OPENCODE_COPILOT_DEBUG !== "false"
const logsDir = new URL("./logs", import.meta.url).pathname
const logPath = new URL(`./logs/log_copilot_plugin_${Date.now()}.log`, import.meta.url).pathname
if (DEBUG) mkdirSync(logsDir, { recursive: true })

const log = (...args: unknown[]) => {
  if (!DEBUG) return
  try {
    const line = `[${new Date().toISOString()}] ${args.map(String).join(" ")}\n`
    appendFileSync(logPath, line)
  } catch {
    // ignore
  }
}

log(`=== copilot-usage ${PLUGIN_VERSION} loaded ===`)
log("logPath:", logPath)

async function loadConfig(): Promise<CopilotConfig> {
  const configPath = new URL("./copilot-usage.config.json", import.meta.url).pathname
  log("loadConfig: trying path:", configPath)
  try {
    const configFile = Bun.file(configPath)
    const exists = await configFile.exists()
    log("loadConfig: file exists:", exists)
    if (exists) {
      const raw = await configFile.text()
      const parsed = JSON.parse(raw) as CopilotConfig
      const maxFromEnv = process.env.OPENCODE_COPILOT_MAX_REQUESTS
      if (maxFromEnv) {
        const envMax = parseFloat(maxFromEnv)
        if (!isNaN(envMax) && envMax > 0) {
          parsed.maxPremiumRequests = envMax
        }
      }
      log("loadConfig: loaded config:", JSON.stringify(parsed))
      return parsed
    }
  } catch (err) {
    log("loadConfig: error:", String(err))
  }

  log("loadConfig: using defaults")
  return {
    maxPremiumRequests: 1500,
    modelMultipliers: {},
  }
}

function getModelId(modelName: string): string | null {
  if (!modelName) return null
  const parts = modelName.split("/")
  if (parts.length < 2) return null
  const provider = parts[0]
  if (!provider.includes("copilot")) return null
  return parts.slice(1).join("/")
}

function getMultiplier(modelName: string, config: CopilotConfig): number {
  const modelId = getModelId(modelName)
  if (!modelId) return 1.0
  if (config.modelMultipliers[modelId] !== undefined) {
    return config.modelMultipliers[modelId]
  }
  const normalized = modelId.toLowerCase()
  for (const [key, value] of Object.entries(config.modelMultipliers)) {
    if (key.toLowerCase() === normalized) return value
  }
  return 1.0
}

function isCopilotModel(modelName: string): boolean {
  if (!modelName) return false
  return modelName.toLowerCase().includes("copilot")
}

function getActiveModel(api: TuiPluginApi, sessionID: string): string | null {
  try {
    const configModel = api.state.config?.model
    log("getActiveModel: config.model:", JSON.stringify(configModel))
    log("getActiveModel: provider count:", (api.state.provider ?? []).length)
    for (const p of api.state.provider ?? []) {
      log("getActiveModel: provider id:", p.id, "name:", p.name)
    }
    if (sessionID) {
      const msgs = api.state.session.messages(sessionID)
      log("getActiveModel: messages count:", msgs.length)
      for (let i = Math.max(0, msgs.length - 3); i < msgs.length; i++) {
        const m = msgs[i]
        if (m.role === "assistant") {
          log("getActiveModel: assistant msg providerID:", m.providerID, "modelID:", m.modelID)
        }
        if (m.role === "user") {
          log("getActiveModel: user msg model:", JSON.stringify((m as any).model))
        }
      }
    }

    // 1. Check global config model (format: "provider/model")
    if (configModel && isCopilotModel(configModel)) {
      log("getActiveModel: found via config.model:", configModel)
      return configModel
    }

    // 2. Check last assistant message in current session
    if (sessionID) {
      const messages = api.state.session.messages(sessionID)
      for (let i = messages.length - 1; i >= 0; i--) {
        const msg = messages[i]
        if (msg.role === "assistant" && msg.providerID?.includes("copilot") && msg.modelID) {
          const result = `${msg.providerID}/${msg.modelID}`
          log("getActiveModel: found via last assistant message:", result)
          return result
        }
      }
    }

    log("getActiveModel: no copilot model found")
  } catch (err) {
    log("getActiveModel error:", String(err))
  }
  return null
}

async function fetchQuotaInfo(token: string): Promise<CopilotQuotaInfo | null> {
  try {
    log("fetchQuotaInfo: fetching quota from github API")
    const response = await fetch("https://api.github.com/copilot_internal/user", {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/json",
        "X-GitHub-Api-Version": "2025-05-01",
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

    // Paid plan: quota_snapshots.premium_interactions
    const snapshot = data?.quota_snapshots?.premium_interactions
    if (snapshot) {
      return {
        percentRemaining: snapshot.percent_remaining ?? 100,
        entitlement: snapshot.entitlement ?? 0,
        overageCount: snapshot.overage_count ?? 0,
        overagePermitted: snapshot.overage_permitted ?? false,
        unlimited: snapshot.unlimited ?? false,
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
        overageCount: 0,
        overagePermitted: false,
        unlimited: false,
      }
    }

    log("fetchQuotaInfo: no quota data found")
    return null
  } catch (err) {
    log("fetchQuotaInfo: error:", String(err))
    return null
  }
}

function buildProgressBar(percentage: number, width: number = 20): string {
  const filled = Math.min(Math.round((percentage / 100) * width), width)
  const empty = width - filled
  return "\u2588".repeat(filled) + "\u2591".repeat(empty)
}

function getUsageColor(percentage: number): string {
  if (percentage > 100) return "#ef4444"
  if (percentage > 90) return "#ef4444"
  if (percentage > 75) return "#eab308"
  return "#22c55e"
}

function CopilotUsageSidebar(props: { api: TuiPluginApi; session_id: string }) {
  log("CopilotUsageSidebar: rendering! session_id:", props.session_id)
  const githubToken = process.env.GITHUB_TOKEN ?? ""
  const hasToken = !!githubToken

  const [config, setConfig] = createSignal<CopilotConfig>({ maxPremiumRequests: 1500, modelMultipliers: {} })
  const [sessionUsage, setSessionUsage] = createSignal<number>(0)
  const [quotaInfo, setQuotaInfo] = createSignal<CopilotQuotaInfo | null>(null)
  const [quotaLoading, setQuotaLoading] = createSignal<boolean>(false)
  const [activeModel, setActiveModel] = createSignal<string | null>(null)
  const [sessionLoading, setSessionLoading] = createSignal<boolean>(false)

  // Load config once on mount
  loadConfig().then(setConfig).catch((err) => log("loadConfig failed:", String(err)))

  async function fetchSessionUsage(sessionID: string, model: string) {
    try {
      const result = await props.api.client.session.messages({
        sessionID,
        limit: 10000,
      })
      let count = 0
      const multiplier = getMultiplier(model, config())
      for (const item of result.data ?? []) {
        if (item.info?.role === "user") {
          count++
        }
      }
      setSessionUsage(count * multiplier)
    } catch (err) {
      log("fetchSessionUsage error:", String(err))
      setSessionUsage(0)
    }
  }

  async function fetchQuota() {
    if (!hasToken) {
      log("fetchQuota: no GITHUB_TOKEN set")
      setQuotaInfo(null)
      setQuotaLoading(false)
      return
    }
    log("fetchQuota: starting, token length:", githubToken.length)
    setQuotaLoading(true)
    const info = await fetchQuotaInfo(githubToken)
    log("fetchQuota: got info:", JSON.stringify(info))
    setQuotaInfo(info)
    setQuotaLoading(false)
  }

  // Reactive model detection: re-runs when config.model or session changes
  // api.state is SolidJS-backed, so property access creates reactive dependencies
  const currentModel = createMemo(() => {
    props.api.state.config?.model // track model changes
    return getActiveModel(props.api, props.session_id)
  })

  // Fallback: poll for model changes in case api.state isn't reactive on first load
  let pollCount = 0
  const modelPoller = setInterval(() => {
    pollCount++
    const configModel = props.api.state.config?.model
    const msgCount = props.api.state.session.messages(props.session_id).length
    const providers = (props.api.state.provider ?? []).map(p => p.id)
    log("poll #" + pollCount + " config.model:", configModel, "msgs:", msgCount, "providers:", providers.join(","))

    const detected = getActiveModel(props.api, props.session_id)
    log("poll #" + pollCount + " detected:", detected, "activeModel:", activeModel())
    if (detected !== activeModel()) {
      log("poll #" + pollCount + " CHANGE detected:", detected)
      setActiveModel(detected)
    }
    // Stop polling after 30 attempts (60s) if we found a model
    if (detected && pollCount > MAX_POLL_ATTEMPTS) {
      clearInterval(modelPoller)
    }
  }, 2000)

  onCleanup(() => clearInterval(modelPoller))

  // React to model changes detected by the poller (when api.state isn't reactive)
  createEffect(() => {
    const model = activeModel()
    if (!model || !isCopilotModel(model)) return
    const sessionID = props.session_id
    if (!sessionID) return
    log("CopilotUsageSidebar: activeModel changed to copilot model:", model)
    setSessionLoading(true)
    fetchSessionUsage(sessionID, model).then(() => setSessionLoading(false))
    fetchQuota()
  })

  createEffect(() => {
    const sessionID = props.session_id
    if (!sessionID) return

    const model = currentModel()
    setActiveModel(model)
    log("CopilotUsageSidebar: sessionID:", sessionID, "model:", model)

    if (model && isCopilotModel(model)) {
      setSessionLoading(true)
      fetchSessionUsage(sessionID, model).then(() => setSessionLoading(false))
    } else {
      setSessionLoading(false)
      setSessionUsage(0)
    }

    fetchQuota()

    const unsubMessage = props.api.event.on("message.updated", (event) => {
      try {
        const e = event as EventMessageUpdated
        if (e.properties.sessionID !== sessionID) return
        const msg = e.properties.info
        if (msg.role !== "user") return
        const curModel = currentModel()
        if (curModel && isCopilotModel(curModel)) {
          const multiplier = getMultiplier(curModel, config())
          setSessionUsage((prev) => prev + multiplier)
        }
      } catch (err) {
        log("message.updated handler error:", String(err))
      }
    })

    const unsubCompacted = props.api.event.on("session.compacted", () => {
      const curModel = currentModel()
      if (curModel && isCopilotModel(curModel)) {
        fetchSessionUsage(sessionID, curModel)
      }
      fetchQuota()
    })

    const refreshInterval = setInterval(() => {
      fetchQuota()
    }, QUOTA_REFRESH_MS)

    onCleanup(() => {
      unsubMessage()
      unsubCompacted()
      clearInterval(refreshInterval)
    })
  })

  const usagePercentage = createMemo(() => {
    const quota = quotaInfo()
    if (!quota || quota.unlimited) return 0
    const used = quota.entitlement * (1 - quota.percentRemaining / 100) + quota.overageCount
    if (quota.entitlement === 0) return 0
    return (used / quota.entitlement) * 100
  })

  const remainingPercentage = createMemo(() => {
    const quota = quotaInfo()
    if (!quota) return 0
    if (quota.unlimited) return 100
    return quota.percentRemaining
  })

  const usageColor = createMemo(() => getUsageColor(usagePercentage()))

  const isCopilot = createMemo(() => {
    const model = currentModel()
    return !!(model && isCopilotModel(model))
  })

  log("CopilotUsageSidebar: render, isCopilot:", isCopilot(), "activeModel:", currentModel())

  return (
    <box flexDirection="column" gap={0}>
      {isCopilot() ? (
        <>
          <text fg={props.api.theme.current?.foreground ?? "#ffffff"}><strong>Github Copilot Usage</strong></text>
          <text fg={props.api.theme.current?.muted ?? "#888888"}>Current Session</text>
          {sessionLoading() ? (
            <text fg={props.api.theme.current?.muted ?? "#888888"}>Loading...</text>
          ) : (
            <text fg="#ffffff">{sessionUsage().toFixed(2)} premium requests</text>
          )}
          <text fg={props.api.theme.current?.muted ?? "#888888"}>Monthly quota</text>
          {!hasToken ? (
            <text fg="#eab308">No token provided (set GITHUB_TOKEN)</text>
          ) : quotaInfo()?.unlimited ? (
            <text fg="#22c55e">Unlimited</text>
          ) : quotaInfo() ? (
            <box flexDirection="column" gap={0}>
              <text fg={usageColor()}>{remainingPercentage().toFixed(1)}% remaining</text>
              <text fg={usageColor()}>{buildProgressBar(100 - remainingPercentage())}</text>
            </box>
          ) : quotaLoading() ? (
            <text fg="#888888">Loading...</text>
          ) : (
            <text fg="#888888">Unable to fetch quota</text>
          )}
        </>
      ) : null}
    </box>
  )
}

const tui: TuiPlugin = async (api) => {
  log("copilot-usage: tui function called")
  api.slots.register({
    order: 175,
    slots: {
      sidebar_content(_ctx, props) {
        log("copilot-usage: rendering sidebar_content, session_id:", props.session_id)
        return <CopilotUsageSidebar api={api} session_id={props.session_id} />
      },
    },
  })
  log("copilot-usage: slot registered")
}

const plugin: TuiPluginModule & { id: string } = {
  id: "copilot-usage",
  tui,
}

export default plugin
