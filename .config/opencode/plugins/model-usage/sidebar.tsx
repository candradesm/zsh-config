/** @jsxImportSource @opentui/solid */
import type { TuiPluginApi } from "@opencode-ai/plugin/tui"
import type { EventMessageUpdated } from "@opencode-ai/sdk/v2"
import { createSignal, createEffect, createMemo, onCleanup } from "solid-js"
import type { CopilotConfig, CopilotQuotaInfo, GoQuotaInfo, MessagePart } from "./types"
import {
  log as logFn,
  DEBUG,
  isSupportedModel, calculateMessageMultiplier,
  roundUsage, buildProgressBar, getUsageColor, getQuotaLabel,
  formatDuration, isModelDeprecated,
  splitCost,
  logPath,
} from "./helpers"
import { appendFileSync } from "node:fs"

const log = logFn
import { fetchQuotaInfo, fetchGoQuota } from "./quota"

const QUOTA_REFRESH_MS = 5 * 60 * 1000
const QUOTA_EVENT_MIN_INTERVAL_MS = 2 * 60 * 1000  // min gap between event-driven fetches
const MAX_POLL_ATTEMPTS = 30
const PLUGIN_VERSION = "v36"

log(`=== usage-sidebar ${PLUGIN_VERSION} loaded ===`)

async function loadConfig(): Promise<CopilotConfig> {
  const configPath = new URL("../model-usage.config.json", import.meta.url).pathname
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
    deprecated: [],
  }
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
    if (configModel && isSupportedModel(configModel)) {
      log("getActiveModel: found via config.model:", configModel)
      return configModel
    }

    // 2. Check last assistant message in current session
    if (sessionID) {
      const messages = api.state.session.messages(sessionID)
      for (let i = messages.length - 1; i >= 0; i--) {
        const msg = messages[i]
        if (msg.role === "assistant" && (msg.providerID?.includes("copilot") || msg.providerID === "opencode-go") && msg.modelID) {
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

function UsageSidebar(props: { api: TuiPluginApi; session_id: string }) {
  log("UsageSidebar: rendering! session_id:", props.session_id)
  const githubToken = process.env.GITHUB_TOKEN ?? ""
  const hasToken = !!githubToken

  const [config, setConfig] = createSignal<CopilotConfig>({ modelMultipliers: {}, deprecated: [] })
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

  const [goQuota, setGoQuota] = createSignal<GoQuotaInfo | null>(null)
  const [goQuotaLoading, setGoQuotaLoading] = createSignal(false)

  const messageMultipliers = new Map<string, number>()
  // Maps messageID → last seen token snapshot for delta calculation (cost billing)
  const processedAssistantMessages = new Map<string, { input: number; cacheRead: number; output: number; cost: number }>()
  // Maps sessionID → peak context window (input + cacheRead) ever seen in that session (for ↑ display)
  const peakPerSession = new Map<string, number>()
  const trackedSessions = new Set<string>()
  let loadedSessionID: string | null = null
  let loadedTokenRootSessionID: string | null = null
  let tokenConfigSnapshot: CopilotConfig | null = null
  let tokenLoadGeneration = 0
  let loadedAllSessionsForRoot: string | null = null
  let lastQuotaFetchAt = 0  // timestamp of last event-driven fetchQuota call

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

  // Track peak context size (input + cacheRead + output) per session.
  // `tokens.cache.read` is the full cached context re-sent every API call — summing across all
  // calls inflates the count (e.g. 514k for a 53k conversation).  Instead, we record the
  // maximum full-call token count (input + cacheRead + output) per session and sum those peaks
  // across sessions. Including output in the peak makes the ↑ figure match the OpenCode context
  // bar (which shows total conversation size including the last response).
  // Cost is accumulated via info.cost deltas from the API.
  function updatePeakContext(sessionId: string, inputTok: number, cacheReadTok: number, outputTok: number) {
    const contextSize = inputTok + cacheReadTok + outputTok
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

        const prevSnapshot = processedAssistantMessages.get(msgId) ?? { input: 0, cacheRead: 0, output: 0, cost: 0 }
        const deltaInput = Math.max(0, inputTok - prevSnapshot.input)
        const deltaCacheRead = Math.max(0, cacheReadTok - prevSnapshot.cacheRead)
        const deltaOutput = Math.max(0, outputTok - prevSnapshot.output)
        const deltaCost = Math.max(0, (info?.cost ?? 0) - prevSnapshot.cost)
        if (deltaInput === 0 && deltaCacheRead === 0 && deltaOutput === 0 && deltaCost === 0) continue

        processedAssistantMessages.set(msgId, { input: inputTok, cacheRead: cacheReadTok, output: outputTok, cost: info?.cost ?? 0 })

        updatePeakContext(sessionID, inputTok, cacheReadTok, outputTok)
        setTotalOutputTokens((prev) => prev + deltaOutput)
        if (deltaCost > 0) {
          const { inputCost, outputCost } = splitCost(
            deltaInput, deltaCacheRead, deltaOutput, deltaCost,
            info?.modelID ?? "",
            props.api.state.provider ?? []
          )
          setTotalInputCost(prev => prev + inputCost)
          setTotalOutputCost(prev => prev + outputCost)
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
    lastQuotaFetchAt = Date.now()
    // Only show loading on initial fetch — keep old data visible during refresh
    if (!quotaInfo()) setQuotaLoading(true)
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

    // Determine if this is the root/primary session (no parentID) or a subagent session.
    // Subagent "user" messages are coordinator instructions, not human requests — they must
    // never trigger quota fetches or premium request counting. Default optimistic (true) so
    // the first message in an unknown session still works; corrected below once the session
    // list resolves.
    let isRootSession = true
    props.api.client.session.list({ limit: 200 })
      .then((result: any) => {
        const sessions = (result as any)?.data ?? result ?? []
        const session = sessions.find((s: any) => (s.id ?? s.sessionID) === sessionID)
        const parentID = session?.parentID ?? session?.info?.parentID
        isRootSession = !parentID
        log("createEffect: sessionID:", sessionID, "parentID:", parentID, "isRootSession:", isRootSession)
      })
      .catch(() => { /* keep optimistic true */ })

    const model = currentModel()
    setActiveModel(model)
    log("createEffect: sessionID:", sessionID, "model:", model, "loadedSessionID:", loadedSessionID, "isSupported:", model ? isSupportedModel(model) : false)

    if (model && isSupportedModel(model)) {
      loadRelatedSessionTokens(sessionID, cfg) // works for both
      if (model.toLowerCase().includes("copilot")) {
        // Copilot: fetch session usage + quota
        if (loadedSessionID !== sessionID) {
          setSessionLoading(true)
          fetchSessionUsage(sessionID).then(() => setSessionLoading(false))
        }
        fetchQuota()
      }
      if (model.toLowerCase().includes("opencode-go")) {
        // opencode-go: fetch go quota
        setGoQuotaLoading(true)
        fetchGoQuota().then((info) => {
          setGoQuota(info)
        }).finally(() => {
          setGoQuotaLoading(false)
        })
      }
    } else {
      setSessionLoading(false)
      if (loadedSessionID !== sessionID) setSessionUsage(0)
    }

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
              // Only fetch quota from the root/primary session. Subagent sessions generate
              // many "user" messages (coordinator instructions) that would spam the GitHub API.
              // Also throttle: heavy sessions can still send many root-level messages quickly.
              if (isRootSession && Date.now() - lastQuotaFetchAt > QUOTA_EVENT_MIN_INTERVAL_MS) {
                fetchQuota()
              }
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
            const msgCost: number = (msg as any)?.cost ?? 0
            if (inputTok > 0 || cacheReadTok > 0 || outputTok > 0 || msgCost > 0) {
              const prevSnapshot = processedAssistantMessages.get(msgId) ?? { input: 0, cacheRead: 0, output: 0, cost: 0 }
              const deltaInput = Math.max(0, inputTok - prevSnapshot.input)
              const deltaCacheRead = Math.max(0, cacheReadTok - prevSnapshot.cacheRead)
              const deltaOutput = Math.max(0, outputTok - prevSnapshot.output)
              const deltaCost = Math.max(0, msgCost - prevSnapshot.cost)
              if (deltaInput > 0 || deltaCacheRead > 0 || deltaOutput > 0 || deltaCost > 0) {
                processedAssistantMessages.set(msgId, { input: inputTok, cacheRead: cacheReadTok, output: outputTok, cost: msgCost })
                updatePeakContext(evtSID, inputTok, cacheReadTok, outputTok)
                setTotalOutputTokens((prev) => prev + deltaOutput)
                if (deltaCost > 0) {
                  const { inputCost, outputCost } = splitCost(
                    deltaInput, deltaCacheRead, deltaOutput, deltaCost,
                    (msg as any)?.modelID ?? "",
                    props.api.state.provider ?? []
                  )
                  setTotalInputCost(prev => prev + inputCost)
                  setTotalOutputCost(prev => prev + outputCost)
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
        if (isRootSession && Date.now() - lastQuotaFetchAt > QUOTA_EVENT_MIN_INTERVAL_MS) {
          fetchQuota()
          log("session.compacted: quota refreshed, sessionID:", sessionID)
        } else {
          log("session.compacted: quota fetch skipped (subagent or too recent), sessionID:", sessionID)
        }
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

    const goRefreshInterval = setInterval(() => {
      if (currentModel()?.toLowerCase().includes("opencode-go")) {
        setGoQuotaLoading(true)
        fetchGoQuota().then((info) => {
          setGoQuota(info)
        }).finally(() => {
          setGoQuotaLoading(false)
        })
      }
    }, QUOTA_REFRESH_MS)

    onCleanup(() => {
      unsubMessageAll()
      unsubCompacted()
      unsubSessionCreated()
      clearInterval(refreshInterval)
      clearInterval(goRefreshInterval)
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

  const isSupported = createMemo(() => {
    const model = currentModel()
    return !!(model && isSupportedModel(model))
  })

  const providerLabel = createMemo(() => {
    const model = currentModel()
    if (!model) return "Usage"
    if (model.toLowerCase().includes("opencode-go")) return "OpenCode Go Usage"
    if (model.toLowerCase().includes("copilot")) return "GitHub Copilot Usage"
    return "Usage"
  })

  const isActiveModelDeprecated = createMemo(() => {
    const model = currentModel()
    if (!model) return false
    const modelId = model.split("/").pop() ?? ""
    return isModelDeprecated(modelId, config())
  })

  const isCopilotActive = createMemo(() => currentModel()?.toLowerCase().includes("copilot") ?? false)
  const isOpenCodeGoActive = createMemo(() => currentModel()?.toLowerCase().includes("opencode-go") ?? false)

  log("UsageSidebar: render, isSupported:", isSupported(), "activeModel:", currentModel())

  return (
    <box flexDirection="column" gap={0}>
      {isSupported() ? (
        <>
          <text fg={props.api.theme.current?.foreground ?? "#ffffff"}><strong>{providerLabel()}</strong></text>
          {isCopilotActive() && !quotaInfo()?.tokenBasedBilling && (
            <>
              <text fg={props.api.theme.current?.muted ?? "#888888"}>Current Session</text>
              {sessionLoading() ? (
                <text fg={props.api.theme.current?.muted ?? "#888888"}>Loading...</text>
              ) : (
                <text fg="#ffffff">{sessionUsage().toFixed(2)} {quotaInfo()?.planType === "free" ? "chat requests" : "premium requests"}</text>
              )}
            </>
          )}
          <text fg={props.api.theme.current?.muted ?? "#888888"}>Cost estimation</text>
          {isActiveModelDeprecated() && (
            <text fg="#ef4444">⚠ Model deprecated</text>
          )}
          <text fg="#ffffff">{("↑ " + peakInputTokens().toLocaleString() + " tokens").padEnd(26) + "$" + totalInputCost().toFixed(2)}</text>
          <text fg="#ffffff">{("↓ " + totalOutputTokens().toLocaleString() + " tokens").padEnd(26) + "$" + totalOutputCost().toFixed(2)}</text>
          <text fg={props.api.theme.current?.foreground ?? "#ffffff"}>
            {"Total".padEnd(26) + "$" + (totalInputCost() + totalOutputCost()).toFixed(2)}
          </text>
          {isCopilotActive() ? (
            <>
              <text fg={props.api.theme.current?.muted ?? "#888888"}>Monthly quota</text>
              {!hasToken ? (
                <text fg="#eab308">No token provided (set GITHUB_TOKEN)</text>
              ) : quotaInfo()?.unlimited ? (
                <text fg="#22c55e">Unlimited</text>
              ) : quotaInfo() ? (
                <box flexDirection="column" gap={0}>
                  <text fg={usageColor()}>{usagePercentage().toFixed(1)}% used</text>
                  <text fg={usageColor()}>{buildProgressBar(usagePercentage())}</text>
                  <text fg="#ffffff">
                    {(quotaInfo()!.entitlement - quotaInfo()!.remaining).toLocaleString()} / {quotaInfo()!.entitlement.toLocaleString()} {getQuotaLabel(quotaInfo()!)}
                  </text>
                </box>
              ) : !quotaInfo() && quotaLoading() ? (
                <text fg="#888888">Loading...</text>
              ) : (
                <text fg="#888888">Unable to fetch quota</text>
              )}
            </>
          ) : isOpenCodeGoActive() ? (
            <>
              <text fg={props.api.theme.current?.muted ?? "#888888"}>Quota</text>
              {!goQuota() && goQuotaLoading() ? (
                <text fg="#888888">Loading...</text>
              ) : goQuota() ? (
                /* If all three bars are null or at 0%, the web page couldn't authenticate */
                (goQuota()!.rolling?.usagePercent ?? 0) === 0 &&
                (goQuota()!.weekly?.usagePercent ?? 0) === 0 &&
                (goQuota()!.monthly?.usagePercent ?? 0) === 0 ? (
                  <box flexDirection="column" gap={0}>
                    <text fg="#eab308">⚠ Unable to fetch Go quota</text>
                    <text fg={props.api.theme.current?.muted ?? "#888888"}>Set OPENCODE_GO_AUTH_COOKIE with your browser's auth cookie</text>
                  </box>
                ) : (
                  <box flexDirection="column" gap={0}>
                    <text fg={props.api.theme.current?.muted ?? "#888888"}>Rolling (5h)</text>
                    <text fg={getUsageColor(goQuota()!.rolling?.usagePercent ?? 0)}>
                      {goQuota()!.rolling?.usagePercent ?? 0}% · resets in {formatDuration(goQuota()!.rolling?.resetInSec ?? 0)}
                    </text>
                    <text fg={getUsageColor(goQuota()!.rolling?.usagePercent ?? 0)}>
                      {buildProgressBar(goQuota()!.rolling?.usagePercent ?? 0)}
                    </text>
                    <text fg={props.api.theme.current?.muted ?? "#888888"}>Weekly</text>
                    <text fg={getUsageColor(goQuota()!.weekly?.usagePercent ?? 0)}>
                      {goQuota()!.weekly?.usagePercent ?? 0}% · resets in {formatDuration(goQuota()!.weekly?.resetInSec ?? 0)}
                    </text>
                    <text fg={getUsageColor(goQuota()!.weekly?.usagePercent ?? 0)}>
                      {buildProgressBar(goQuota()!.weekly?.usagePercent ?? 0)}
                    </text>
                    <text fg={props.api.theme.current?.muted ?? "#888888"}>Monthly</text>
                    <text fg={getUsageColor(goQuota()!.monthly?.usagePercent ?? 0)}>
                      {goQuota()!.monthly?.usagePercent ?? 0}% · resets in {formatDuration(goQuota()!.monthly?.resetInSec ?? 0)}
                    </text>
                    <text fg={getUsageColor(goQuota()!.monthly?.usagePercent ?? 0)}>
                      {buildProgressBar(goQuota()!.monthly?.usagePercent ?? 0)}
                    </text>
                  </box>
                )
              ) : (
                <text fg="#888888">Set OPENCODE_GO_WORKSPACE_ID + OPENCODE_GO_AUTH_COOKIE for Go quota</text>
              )}
            </>
          ) : null}
        </>
      ) : null}
    </box>
  )
}

export default UsageSidebar
