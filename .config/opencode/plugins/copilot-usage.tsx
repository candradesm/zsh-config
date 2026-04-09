/** @jsxImportSource @opentui/solid */
import type { TuiPlugin, TuiPluginModule, TuiPluginApi } from "@opencode-ai/plugin/tui"
import type { EventMessageUpdated } from "@opencode-ai/sdk/v2"
import { createSignal, createEffect, createMemo, onCleanup } from "solid-js"
import { mkdirSync, appendFileSync } from "node:fs"

const QUOTA_REFRESH_MS = 5 * 60 * 1000
const MAX_POLL_ATTEMPTS = 30
const PLUGIN_VERSION = "v16-fix-off-by-1"

interface CopilotConfig {
  modelMultipliers: Record<string, number>
}

interface CopilotQuotaInfo {
  percentRemaining: number
  entitlement: number
  overageCount: number
  overagePermitted: boolean
  unlimited: boolean
  planType: "free" | "paid"
}

interface MessagePart {
  type: string
  synthetic?: boolean
}

const DEBUG = process.env.OPENCODE_COPILOT_DEBUG === "true"
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
      log("loadConfig: loaded config:", JSON.stringify(parsed))
      return parsed
    }
  } catch (err) {
    log("loadConfig: error:", String(err))
  }

  log("loadConfig: using defaults")
  return {
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

function isSyntheticMessage(parts: MessagePart[]): boolean {
  return parts.some((p) => p.type === "text" && p.synthetic === true)
}

function calculateMessageMultiplier(
  msgId: string,
  parts: MessagePart[],
  model: string | null,
  isFreePlan: boolean,
  config: CopilotConfig,
  messageMultipliers: Map<string, number>
): number {
  if (isSyntheticMessage(parts)) {
    // Don't store in map — storing 0 would permanently blacklist the message ID,
    // preventing any future retry if parts change (e.g. message.updated fires again).
    log("calculateMessageMultiplier: skipping synthetic message", msgId)
    return 0
  }

  if (!model || getModelId(model) === null) {
    // Don't store in map — allows retry when the model becomes available on the next event fire.
    log("calculateMessageMultiplier: no copilot model for", msgId, "model:", model)
    return 0
  }

  const multiplier = isFreePlan ? 1.0 : getMultiplier(model, config)
  log("calculateMessageMultiplier:", msgId, "model:", model, "multiplier:", multiplier)
  // Only store positive results — the deduplication guard in message.updated checks this map.
  messageMultipliers.set(msgId, multiplier)
  return multiplier
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
        planType: "paid",
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
        planType: "free",
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

function roundUsage(value: number): number {
  let rounded = Math.round(value * 100) / 100
  // Handle imprecise multiplier artifacts (0.33 ≈ 1/3):
  // 2×0.33=0.65→0.67, 4×0.33=1.32→1.33, etc.
  let cents = Math.round((rounded % 1) * 100)
  if (cents > 0 && cents < 100 && cents % 33 === 32) {
    rounded = Math.round((rounded + 0.01) * 100) / 100
    cents = Math.round((rounded % 1) * 100)
  }
  // Handle .99 → round up (3×0.33=0.99→1.00)
  if (cents === 99) {
    return Math.ceil(rounded)
  }
  return rounded
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

  const [config, setConfig] = createSignal<CopilotConfig>({ modelMultipliers: {} })
  const [sessionUsage, setSessionUsage] = createSignal<number>(0)
  const [quotaInfo, setQuotaInfo] = createSignal<CopilotQuotaInfo | null>(null)
  const [quotaLoading, setQuotaLoading] = createSignal<boolean>(false)
  const [activeModel, setActiveModel] = createSignal<string | null>(null)
  const [sessionLoading, setSessionLoading] = createSignal<boolean>(false)

  const messageMultipliers = new Map<string, number>()
  let loadedSessionID: string | null = null

  // Load config once on mount
  loadConfig().then(setConfig).catch((err) => log("loadConfig failed:", String(err)))

  async function fetchSessionUsage(sessionID: string) {
    messageMultipliers.clear()
    try {
      log("fetchSessionUsage: fetching messages for session:", sessionID)
      const result = await props.api.client.session.messages({
        sessionID,
        limit: 10000,
      })
      const messages = result.data ?? []
      log("fetchSessionUsage: got", messages.length, "messages")
      if (messages.length > 0) {
        log("fetchSessionUsage: first msg keys:", Object.keys(messages[0] as any).join(","), "id:", messages[0].id)
        log("fetchSessionUsage: first msg info keys:", Object.keys(messages[0].info as any ?? {}).join(","), "info.id:", (messages[0].info as any)?.id)
        log("fetchSessionUsage: first msg full info:", JSON.stringify(messages[0].info))
      }

      // Collect user messages — model is read directly from UserMessage.model (required field in
      // OpenCode schema: z.object({ providerID, modelID, variant? }), never optional).
      // api.client.session.messages() returns { info: Message, parts: Part[] }[] so parts are
      // available directly without a separate api.state.part() call.
      const userMsgs: { id: string; model: string | null; parts: MessagePart[] }[] = []
      for (const item of messages) {
        const msgId = item.id ?? (item.info as any)?.id ?? (item as any)?.messageID ?? (item as any)?.uid
        log("fetchSessionUsage: checking msg id:", msgId, "role:", item.info?.role)
        if (item.info?.role === "user" && msgId) {
          const parts = ((item as any).parts ?? []) as MessagePart[]
          // Read model directly from UserMessage.model (providerID/modelID nested object)
          const infoModel = (item.info as any)?.model
          const model = infoModel?.providerID && infoModel?.modelID
            ? `${infoModel.providerID}/${infoModel.modelID}` : null
          log("fetchSessionUsage: user msg", msgId, "direct model:", model, "parts:", parts.length)
          userMsgs.push({ id: msgId, model, parts })
        }
      }
      log("fetchSessionUsage: collected", userMsgs.length, "user messages")

      // Pass 1: REVERSE scan — assign each assistant msg to the nearest preceding user msg
      let uIdx = userMsgs.length - 1
      for (let i = messages.length - 1; i >= 0 && uIdx >= 0; i--) {
        const role = messages[i].info?.role
        if (role === "user") {
          uIdx--
        } else if (role === "assistant" && uIdx >= 0 && !userMsgs[uIdx].model) {
          const providerID = (messages[i].info as any).providerID
          const modelID = (messages[i].info as any).modelID
          if (providerID && modelID) {
            userMsgs[uIdx].model = `${providerID}/${modelID}`
          }
        }
      }

      // Pass 2: for user msgs still without model, look ahead at next assistant AFTER them
      let msgIdx = 0
      for (const um of userMsgs) {
        if (um.model) continue
        // Find this user msg's position in the messages array
        while (msgIdx < messages.length) {
          if (messages[msgIdx].info?.role === "user" && messages[msgIdx].id === um.id) {
            msgIdx++
            break
          }
          msgIdx++
        }
        // Look ahead for next assistant
        while (msgIdx < messages.length) {
          const role = messages[msgIdx].info?.role
          if (role === "assistant") {
            const providerID = (messages[msgIdx].info as any).providerID
            const modelID = (messages[msgIdx].info as any).modelID
            if (providerID && modelID) {
              um.model = `${providerID}/${modelID}`
              break
            }
          }
          msgIdx++
        }
      }

      // Pass 3: Final fallback — assign active model to any user msg still without one.
      // Handles the most recent user message (no assistant response yet) and any edge case
      // where item.info.model is absent in the API response.
      const fallbackModel = getActiveModel(props.api, sessionID)
      if (fallbackModel) {
        for (const um of userMsgs) {
          if (!um.model) {
            um.model = fallbackModel
            log("fetchSessionUsage: pass3 fallback model for msg:", um.id, "model:", fallbackModel)
          }
        }
      }

      // Calculate total
      const isFreePlan = quotaInfo()?.planType === "free"
      let total = 0
      for (const um of userMsgs) {
        total += calculateMessageMultiplier(um.id, um.parts, um.model, isFreePlan, config(), messageMultipliers)
      }

      log("fetchSessionUsage: total usage:", total)
      setSessionUsage(roundUsage(total))
      loadedSessionID = sessionID
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
    const detected = getActiveModel(props.api, props.session_id)
    if (detected !== activeModel()) {
      log("poll #" + pollCount + " model change:", detected)
      setActiveModel(detected)
    }
    if (detected && pollCount > MAX_POLL_ATTEMPTS) {
      clearInterval(modelPoller)
    }
  }, 2000)

  onCleanup(() => clearInterval(modelPoller))

  createEffect(() => {
    const sessionID = props.session_id
    if (!sessionID) {
      log("createEffect: no sessionID, skipping")
      return
    }

    const model = currentModel()
    setActiveModel(model)
    log("createEffect: sessionID:", sessionID, "model:", model, "loadedSessionID:", loadedSessionID, "isCopilot:", model ? isCopilotModel(model) : false)

    // Fetch quota first so planType is available for fetchSessionUsage
    fetchQuota().then(() => {
      if (model && isCopilotModel(model)) {
        if (loadedSessionID !== sessionID) {
          setSessionLoading(true)
          fetchSessionUsage(sessionID).then(() => setSessionLoading(false))
        }
      } else {
        setSessionLoading(false)
        if (loadedSessionID !== sessionID) setSessionUsage(0)
      }
    })

    const unsubMessage = props.api.event.on("message.updated", (event) => {
      try {
        const e = event as EventMessageUpdated
        if (e.properties.sessionID !== sessionID) return
        const msg = e.properties.info
        if (msg.role !== "user") return
        if (msg.id && messageMultipliers.has(msg.id)) return

        // 1. Read model directly from UserMessage.model (required field per OpenCode schema)
        const userModel = (msg as any)?.model
        let lastModel: string | null = userModel?.providerID && userModel?.modelID
          ? `${userModel.providerID}/${userModel.modelID}` : null

        // 2. Fallback: scan last assistant message in session state (≤100 msgs)
        if (!lastModel) {
          const msgs = props.api.state.session.messages(sessionID)
          let lastProviderID: string | undefined
          let lastModelID: string | undefined
          for (let i = msgs.length - 1; i >= 0; i--) {
            if (msgs[i].role === "assistant") {
              lastProviderID = msgs[i].providerID
              lastModelID = msgs[i].modelID
              break
            }
          }
          lastModel = lastProviderID && lastModelID ? `${lastProviderID}/${lastModelID}` : null
        }

        // 3. Final fallback: configured/detected active model (handles first message in session)
        if (!lastModel) {
          lastModel = getActiveModel(props.api, sessionID)
        }
        const parts = (props.api.state.part(msg.id!) ?? []) as MessagePart[]
        const isFreePlan = quotaInfo()?.planType === "free"
        const multiplier = calculateMessageMultiplier(msg.id!, parts, lastModel, isFreePlan, config(), messageMultipliers)
        if (multiplier > 0) {
          setSessionUsage((prev) => roundUsage(prev + multiplier))
        }
      } catch (err) {
        log("message.updated handler error:", String(err))
      }
    })

    const unsubCompacted = props.api.event.on("session.compacted", () => {
      // Compaction messages are counted in message.updated; synthetic ones skipped via flag
      fetchQuota()
      log("session.compacted: quota refreshed")
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
            <text fg="#ffffff">{sessionUsage().toFixed(2)} {quotaInfo()?.planType === "free" ? "chat requests" : "premium requests"}</text>
          )}
          <text fg={props.api.theme.current?.muted ?? "#888888"}>Monthly quota</text>
          {!hasToken ? (
            <text fg="#eab308">No token provided (set GITHUB_TOKEN)</text>
          ) : quotaInfo()?.unlimited ? (
            <text fg="#22c55e">Unlimited</text>
          ) : quotaInfo() ? (
            <box flexDirection="column" gap={0}>
              <text fg={usageColor()}>{usagePercentage().toFixed(1)}% used</text>
              <text fg={usageColor()}>{buildProgressBar(usagePercentage())}</text>
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
