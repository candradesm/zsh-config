/** @jsxImportSource @opentui/solid */
import type { TuiPlugin, TuiPluginModule, TuiPluginApi } from "@opencode-ai/plugin/tui"
import type { EventMessageUpdated } from "@opencode-ai/sdk/v2"
import { createSignal, createEffect, createMemo, onCleanup } from "solid-js"
import { mkdirSync, appendFileSync } from "node:fs"

const QUOTA_REFRESH_MS = 5 * 60 * 1000
const MAX_POLL_ATTEMPTS = 30
const PLUGIN_VERSION = "v32"

interface TokenPrice {
  input: number
  cacheRead?: number
  output: number
}

interface CopilotConfig {
  modelMultipliers: Record<string, number>
  tokenPricing: Record<string, TokenPrice>
  deprecated: string[]
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
      const parsed = JSON.parse(raw) as Partial<CopilotConfig>
      const cfg: CopilotConfig = {
        modelMultipliers: parsed.modelMultipliers ?? {},
        tokenPricing: parsed.tokenPricing ?? {},
        deprecated: parsed.deprecated ?? [],
      }
      log("loadConfig: loaded config:", JSON.stringify(cfg))
      return cfg
    }
  } catch (err) {
    log("loadConfig: error:", String(err))
  }

  log("loadConfig: using defaults")
  return {
    modelMultipliers: {},
    tokenPricing: {},
    deprecated: [],
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

function getTokenPrice(modelId: string, config: CopilotConfig): TokenPrice | null {
  if (!modelId) return null
  if (config.tokenPricing[modelId] !== undefined) return config.tokenPricing[modelId]
  const normalized = modelId.toLowerCase()
  for (const [key, value] of Object.entries(config.tokenPricing)) {
    if (key.toLowerCase() === normalized) return value
  }
  return null
}

function calcCost(tokens: number, pricePerMillion: number): number {
  return (tokens / 1_000_000) * pricePerMillion
}

function isModelDeprecated(modelId: string, config: CopilotConfig): boolean {
  if (!modelId) return false
  const normalized = modelId.toLowerCase()
  return config.deprecated.some((d) => d.toLowerCase() === normalized)
}

function isCopilotModel(modelName: string): boolean {
  if (!modelName) return false
  return modelName.toLowerCase().includes("copilot")
}

function isSyntheticMessage(parts: MessagePart[]): boolean {
  // Messages with a "compaction" type part are the real compaction request — always count them.
  if (parts.some((p) => p.type === "compaction")) return false
  // The synthetic *continuation* message (auto-created after compaction to resume the chat)
  // has ONLY {type:"text", synthetic:true} parts and nothing else.
  // Real user messages may also contain synthetic text parts (e.g. the first message in a
  // session after context refill), but they always have at least one non-synthetic part too
  // (e.g. a plain "text" part, a "file" part, etc.).
  const syntheticTextParts = parts.filter((p) => p.type === "text" && p.synthetic === true)
  if (syntheticTextParts.length === 0) return false
  const nonSyntheticParts = parts.filter((p) => !(p.type === "text" && p.synthetic === true))
  return nonSyntheticParts.length === 0
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

function formatCostLine(arrow: string, tokens: number, cost: number): string {
  return `${arrow} ${tokens.toLocaleString()} tokens`.padEnd(26) + `$${cost.toFixed(2)}`
}

function CopilotUsageSidebar(props: { api: TuiPluginApi; session_id: string }) {
  log("CopilotUsageSidebar: rendering! session_id:", props.session_id)
  const githubToken = process.env.GITHUB_TOKEN ?? ""
  const hasToken = !!githubToken

  const [config, setConfig] = createSignal<CopilotConfig>({ modelMultipliers: {}, tokenPricing: {}, deprecated: [] })
  const [sessionUsage, setSessionUsage] = createSignal<number>(0)
  const [quotaInfo, setQuotaInfo] = createSignal<CopilotQuotaInfo | null>(null)
  const [quotaLoading, setQuotaLoading] = createSignal<boolean>(false)
  const [activeModel, setActiveModel] = createSignal<string | null>(null)
  const [sessionLoading, setSessionLoading] = createSignal<boolean>(false)
  const [peakInputTokens, setPeakInputTokens] = createSignal<number>(0)
  const [totalOutputTokens, setTotalOutputTokens] = createSignal<number>(0)
  const [totalInputCost, setTotalInputCost] = createSignal<number>(0)
  const [totalOutputCost, setTotalOutputCost] = createSignal<number>(0)
  const [configLoaded, setConfigLoaded] = createSignal<boolean>(false)

  const messageMultipliers = new Map<string, number>()
  // Maps messageID → last seen token snapshot for delta calculation (cost billing)
  const processedAssistantMessages = new Map<string, { input: number; cacheRead: number; output: number }>()
  // Maps sessionID → peak context window (input + cacheRead) ever seen in that session (for ↑ display)
  const peakPerSession = new Map<string, number>()
  const trackedSessions = new Set<string>()
  let loadedSessionID: string | null = null
  let loadedTokenRootSessionID: string | null = null
  let tokenConfigSnapshot: CopilotConfig | null = null
  let tokenLoadGeneration = 0
  let loadedAllSessionsForRoot: string | null = null

  // Load config once on mount
  loadConfig().then((cfg) => { setConfig(cfg); setConfigLoaded(true) }).catch((err) => log("loadConfig failed:", String(err)))

  async function fetchSessionUsage(sessionID: string) {
    messageMultipliers.clear()
    try {
      log("fetchSessionUsage: fetching messages for session:", sessionID)
      const result = await props.api.client.session.messages({
        sessionID,
        limit: 10000,
      })
      const rawResult = (result as any)?.data ?? result
      const messages = Array.isArray(rawResult) ? rawResult : []
      log("fetchSessionUsage: got", messages.length, "messages (raw type:", typeof (result as any)?.data, "isArray:", Array.isArray((result as any)?.data), ")")
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
          // Skip messages from subagent sessions (compaction in a child session is a tool call, not a premium request)
          if (item.info?.sessionID && item.info.sessionID !== sessionID) {
            log("fetchSessionUsage: skipping subagent message", msgId, "sessionID:", item.info.sessionID)
            continue
          }
          const parts = ((item as any).parts ?? []) as MessagePart[]
          // Read model directly from UserMessage.model (providerID/modelID nested object)
          const infoModel = (item.info as any)?.model
          const model = infoModel?.providerID && infoModel?.modelID
            ? `${infoModel.providerID}/${infoModel.modelID}` : null
          log("fetchSessionUsage: user msg", msgId, "direct model:", model, "parts:", parts.length,
            "partTypes:", parts.map((p: any) => p.type + (p.synthetic ? "[synthetic]" : "")).join(","))
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

  function resetTokenTracking(sessionID: string, cfg: CopilotConfig) {
    tokenLoadGeneration++
    processedAssistantMessages.clear()
    peakPerSession.clear()
    trackedSessions.clear()
    loadedAllSessionsForRoot = null
    setPeakInputTokens(0)
    setTotalOutputTokens(0)
    setTotalInputCost(0)
    setTotalOutputCost(0)
    loadedTokenRootSessionID = sessionID
    tokenConfigSnapshot = cfg
  }

  // Track peak context size (input + cacheRead) per session.
  // `tokens.cache.read` is the full cached context re-sent every API call — summing across all
  // calls inflates the count (e.g. 514k for a 53k conversation).  Instead, we record the
  // maximum context window ever used per session and sum those peaks across sessions.
  // Cost calculation is unchanged — it still accumulates all billable deltas correctly.
  function updatePeakContext(sessionId: string, inputTok: number, cacheReadTok: number) {
    const contextSize = inputTok + cacheReadTok
    const prev = peakPerSession.get(sessionId) ?? 0
    if (contextSize > prev) {
      const delta = contextSize - prev
      peakPerSession.set(sessionId, contextSize)
      setPeakInputTokens((p) => p + delta)
    }
  }

  async function loadSessionTokens(sessionID: string, cfg: CopilotConfig) {
    const generation = tokenLoadGeneration
    try {
      const result = await props.api.client.session.messages({ sessionID, limit: 10000 })
      if (generation !== tokenLoadGeneration) return
      const rawResult = (result as any)?.data ?? result
      const messages = Array.isArray(rawResult) ? rawResult : []
      log("loadSessionTokens:", sessionID, "raw type:", typeof (result as any)?.data, "isArray:", Array.isArray((result as any)?.data), "count:", messages.length)
      const itemLogLines: string[] = []
      for (const item of messages) {
        const msgId = item.id ?? (item.info as any)?.id
        if (!msgId) continue
        const role = item.info?.role ?? (item as any)?.role
        if (DEBUG) itemLogLines.push(`[${new Date().toISOString()}] loadSessionTokens item: ${msgId} role: ${role} inputTok: ${(item.info as any)?.tokens?.input} outputTok: ${(item.info as any)?.tokens?.output}`)
        if (role !== "assistant") continue

        const info = item.info as any
        const inputTok: number = info?.tokens?.input ?? 0
        const cacheReadTok: number = info?.tokens?.cache?.read ?? 0
        const outputTok: number = info?.tokens?.output ?? 0
        if (inputTok === 0 && cacheReadTok === 0 && outputTok === 0) continue

        const prevSnapshot = processedAssistantMessages.get(msgId) ?? { input: 0, cacheRead: 0, output: 0 }
        const deltaInput = Math.max(0, inputTok - prevSnapshot.input)
        const deltaCacheRead = Math.max(0, cacheReadTok - prevSnapshot.cacheRead)
        const deltaOutput = Math.max(0, outputTok - prevSnapshot.output)
        if (deltaInput === 0 && deltaCacheRead === 0 && deltaOutput === 0) continue

        processedAssistantMessages.set(msgId, { input: inputTok, cacheRead: cacheReadTok, output: outputTok })
        const modelId: string = info?.modelID ?? ""
        const price = getTokenPrice(modelId, cfg)

        updatePeakContext(sessionID, inputTok, cacheReadTok)
        setTotalOutputTokens((prev) => prev + deltaOutput)
        if (price) {
          setTotalInputCost((prev) => prev + calcCost(deltaInput, price.input) + calcCost(deltaCacheRead, price.cacheRead ?? 0))
          setTotalOutputCost((prev) => prev + calcCost(deltaOutput, price.output))
        }
      }
      if (DEBUG && itemLogLines.length > 0) {
        try { appendFileSync(logPath, itemLogLines.join("\n") + "\n") } catch { /* ignore */ }
      }
    } catch (err) {
      log("loadSessionTokens error:", String(err))
    }
  }

  async function loadRelatedSessionTokens(sessionID: string, cfg: CopilotConfig) {
    if (loadedTokenRootSessionID !== sessionID || tokenConfigSnapshot !== cfg) {
      resetTokenTracking(sessionID, cfg)
    }
    const generation = tokenLoadGeneration

    if (!trackedSessions.has(sessionID)) {
      trackedSessions.add(sessionID)
      loadSessionTokens(sessionID, cfg)
    }

    const alreadyWalked = loadedAllSessionsForRoot === sessionID
    if (!alreadyWalked) {
      loadedAllSessionsForRoot = sessionID
      try {
        const sessionList = await props.api.client.session.list({ limit: 200 })
        if (generation !== tokenLoadGeneration) return
        const allSessions = (sessionList as any)?.data ?? sessionList ?? []
        let changed = true
        while (changed) {
          changed = false
          for (const s of allSessions) {
            const sid = s.id ?? s.sessionID
            const pid = s.parentID ?? s.info?.parentID
            if (!sid || trackedSessions.has(sid)) continue
            if (pid && trackedSessions.has(pid)) {
              trackedSessions.add(sid)
              loadSessionTokens(sid, cfg)
              changed = true
            }
          }
        }
      } catch (err) {
        log("session.list error:", String(err))
      }
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
    if (!configLoaded()) return
    const sessionID = props.session_id
    const cfg = config()
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
        loadRelatedSessionTokens(sessionID, cfg)
        if (loadedSessionID !== sessionID) {
          setSessionLoading(true)
          fetchSessionUsage(sessionID).then(() => setSessionLoading(false))
        }
      } else {
        setSessionLoading(false)
        if (loadedSessionID !== sessionID) setSessionUsage(0)
      }
    })

    const unsubMessageAll = props.api.event.on("message.updated", (event: any) => {
      try {
        const sessionID_outer = sessionID
        const e = event as EventMessageUpdated
        const evtSID = e.properties?.sessionID ?? (event as any).properties?.sessionID
        const msg = e.properties?.info ?? (event as any).properties?.info

        // --- Premium request counting (user messages, coordinator session only) ---
        if (evtSID === sessionID_outer && msg?.role === "user") {
          const msgId = msg?.id
          if (msgId && !messageMultipliers.has(msgId)) {
            // 1. Read model directly from UserMessage.model
            const userModel = (msg as any)?.model
            let lastModel: string | null = userModel?.providerID && userModel?.modelID
              ? `${userModel.providerID}/${userModel.modelID}` : null

            // 2. Fallback: scan last assistant message in session state
            if (!lastModel) {
              const msgs = props.api.state.session.messages(sessionID_outer)
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

            // 3. Final fallback: active model
            if (!lastModel) lastModel = getActiveModel(props.api, sessionID_outer)

            const parts = (props.api.state.part(msgId) ?? []) as MessagePart[]
            if (parts.some((p) => p.type === "compaction")) {
              log("message.updated: compaction message detected", msgId)
            }
            const isFreePlan = quotaInfo()?.planType === "free"
            const multiplier = calculateMessageMultiplier(msgId, parts, lastModel, isFreePlan, config(), messageMultipliers)
            if (multiplier > 0) {
              setSessionUsage((prev) => roundUsage(prev + multiplier))
              fetchQuota()
            }
          }
        }

        // --- Token cost counting (assistant messages, all tracked sessions) ---
        if (trackedSessions.has(evtSID) && msg?.role === "assistant") {
          const msgId = msg?.id
          if (msgId) {
            const inputTok: number = (msg as any)?.tokens?.input ?? 0
            const cacheReadTok: number = (msg as any)?.tokens?.cache?.read ?? 0
            const outputTok: number = (msg as any)?.tokens?.output ?? 0
            if (inputTok > 0 || cacheReadTok > 0 || outputTok > 0) {
              const prevSnapshot = processedAssistantMessages.get(msgId) ?? { input: 0, cacheRead: 0, output: 0 }
              const deltaInput = Math.max(0, inputTok - prevSnapshot.input)
              const deltaCacheRead = Math.max(0, cacheReadTok - prevSnapshot.cacheRead)
              const deltaOutput = Math.max(0, outputTok - prevSnapshot.output)
              if (deltaInput > 0 || deltaCacheRead > 0 || deltaOutput > 0) {
                processedAssistantMessages.set(msgId, { input: inputTok, cacheRead: cacheReadTok, output: outputTok })
                const modelId: string = (msg as any)?.modelID ?? ""
                const price = getTokenPrice(modelId, config())
                updatePeakContext(evtSID, inputTok, cacheReadTok)
                setTotalOutputTokens((prev) => prev + deltaOutput)
                if (price) {
                  setTotalInputCost((prev) => prev + calcCost(deltaInput, price.input) + calcCost(deltaCacheRead, price.cacheRead ?? 0))
                  setTotalOutputCost((prev) => prev + calcCost(deltaOutput, price.output))
                }
              }
            }
          }
        }
      } catch (err) {
        log("message.updated combined handler error:", String(err))
      }
    })

    const unsubCompacted = props.api.event.on("session.compacted", (evt) => {
      const evtSID = (evt as any).properties?.sessionID

      // Premium requests: refresh quota only for root session compaction (unchanged behaviour)
      if (evtSID === sessionID) {
        fetchQuota()
        log("session.compacted: quota refreshed, sessionID:", sessionID)
      }

      // Token costs: when any tracked session is compacted, the old assistant messages are
      // replaced by a compaction summary message. Counting both would double-count all tokens.
      // Reset everything and re-fetch from the now-compacted state — same principle as how
      // messageMultipliers deduplication keeps premium requests correct after compaction.
      if (evtSID && trackedSessions.has(evtSID)) {
        log("session.compacted: resetting token tracking due to compaction in session:", evtSID)
        resetTokenTracking(sessionID, config())
        loadRelatedSessionTokens(sessionID, config())
      }
    })

    const unsubSessionCreated = props.api.event.on("session.created", (event: any) => {
      const { sessionID: newSID, info } = event.properties ?? {}
      const parentID = info?.parentID
      if (!newSID || trackedSessions.has(newSID)) return
      if (parentID && trackedSessions.has(parentID)) {
        log("session.created: new child session:", newSID, "parent:", parentID)
        trackedSessions.add(newSID)
        loadSessionTokens(newSID, config())
      }
    })

    const refreshInterval = setInterval(() => {
      fetchQuota()
    }, QUOTA_REFRESH_MS)

    onCleanup(() => {
      unsubMessageAll()
      unsubCompacted()
      unsubSessionCreated()
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

  const isActiveModelDeprecated = createMemo(() => {
    const model = currentModel()
    if (!model) return false
    const modelId = model.split("/").pop() ?? ""
    return isModelDeprecated(modelId, config())
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
          <text fg={props.api.theme.current?.muted ?? "#888888"}>Cost estimation</text>
          {isActiveModelDeprecated() && (
            <text fg="#ef4444">⚠ Model deprecated</text>
          )}
          <text fg="#ffffff">{formatCostLine("↑", peakInputTokens(), totalInputCost())}</text>
          <text fg="#ffffff">{formatCostLine("↓", totalOutputTokens(), totalOutputCost())}</text>
          <text fg={props.api.theme.current?.foreground ?? "#ffffff"}>
            {"Total".padEnd(26) + "$" + (totalInputCost() + totalOutputCost()).toFixed(2)}
          </text>
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
