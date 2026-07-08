/** @jsxImportSource @opentui/solid */
import type { TuiPluginApi } from "@opencode-ai/plugin/tui"
import type { AssistantMessage, Message, EventMessageUpdated, EventSessionCompacted, EventSessionCreated } from "@opencode-ai/sdk/v2"
import { createSignal, createEffect, createMemo, onCleanup } from "solid-js"
import type { CopilotQuotaInfo, GoQuotaInfo } from "./types"
import { log as logFn, DEBUG, logPath } from "./helpers/debug"
import { isSupportedModel } from "./helpers/model"
import { buildProgressBar, getUsageColor, getQuotaLabel, formatDuration } from "./helpers/format"
import { splitCost } from "./helpers/cost"
import { appendFileSync } from "node:fs"
import { createLoadGuard } from "./shared/reload"
import { fetchQuotaInfo, fetchGoQuota, withGuard } from "./quota"

const log = logFn

const QUOTA_REFRESH_MS = 5 * 60 * 1000
const QUOTA_EVENT_MIN_INTERVAL_MS = 2 * 60 * 1000  // min gap between event-driven fetches
const MAX_POLL_ATTEMPTS = 30
const PLUGIN_VERSION = "v41"

log(`=== usage-sidebar ${PLUGIN_VERSION} loaded ===`)

interface Theme {
  foreground?: string
  muted?: string
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
          // `model` only exists on UserMessage, already guarded by role check
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

// ─── Token tracking hook ──────────────────────────────────────────────────────

function useTokenTracking(props: { api: TuiPluginApi; sessionID: string }) {
  const [peakInputTokens, setPeakInputTokens] = createSignal<number>(0)
  const [totalOutputTokens, setTotalOutputTokens] = createSignal<number>(0)
  const [totalInputCost, setTotalInputCost] = createSignal<number>(0)
  const [totalOutputCost, setTotalOutputCost] = createSignal<number>(0)
  const [totalCacheReadTokens, setTotalCacheReadTokens] = createSignal<number>(0)
  const [totalNonCachedInputTokens, setTotalNonCachedInputTokens] = createSignal<number>(0)

  // Maps messageID → last seen token snapshot for delta calculation (cost billing)
  const processedAssistantMessages = new Map<string, { input: number; cacheRead: number; output: number; cost: number }>()
  // Maps sessionID → peak context window (input + cacheRead) ever seen in that session (for ↑ display)
  const peakPerSession = new Map<string, number>()
  const trackedSessions = new Set<string>()
  let loadedTokenRootSessionID: string | null = null
  let loadedAllSessionsForRoot: string | null = null
  const loadGuard = createLoadGuard()
  let currentTokenGen = loadGuard.invalidate()

  function resetTokenTracking(sessionID: string) {
    currentTokenGen = loadGuard.invalidate()
    processedAssistantMessages.clear()
    peakPerSession.clear()
    trackedSessions.clear()
    loadedAllSessionsForRoot = null
    setPeakInputTokens(0)
    setTotalOutputTokens(0)
    setTotalInputCost(0)
    setTotalOutputCost(0)
    setTotalCacheReadTokens(0)
    setTotalNonCachedInputTokens(0)
    loadedTokenRootSessionID = sessionID
  }

  // Track peak input tokens (input + cacheRead — no output) per session.
  // `tokens.cache.read` is the full cached context re-sent every API call — summing across all
  // calls inflates the count (e.g. 514k for a 53k conversation).  Instead, we record the
  // maximum input-prompt token count (input + cacheRead) per session and sum those peaks
  // across sessions. Output is shown separately on the ↓ line.
  function updatePeakContext(sessionId: string, inputTok: number, cacheReadTok: number, _outputTok: number) {
    const contextSize = inputTok + cacheReadTok
    const prev = peakPerSession.get(sessionId) ?? 0
    if (contextSize > prev) {
      const delta = contextSize - prev
      peakPerSession.set(sessionId, contextSize)
      setPeakInputTokens((p) => p + delta)
    }
  }

  async function loadSessionTokens(sessionID: string) {
    const gen = currentTokenGen
    try {
      const result = await props.api.client.session.messages({ sessionID, limit: 10000 })
      if (!loadGuard.isCurrent(gen)) return
      const rawResult = (result as { data: Array<{ id: string; info: Message }> }).data ?? result
      const messages = Array.isArray(rawResult) ? rawResult : []
      log("loadSessionTokens:", sessionID, "raw type:", typeof (result as any)?.data, "isArray:", Array.isArray((result as any)?.data), "count:", messages.length)
      const itemLogLines: string[] = []
      for (const item of messages) {
        const msgId = item.id ?? item.info?.id
        if (!msgId) continue
        const role = item.info?.role
        if (DEBUG) itemLogLines.push(`[${new Date().toISOString()}] loadSessionTokens item: ${msgId} role: ${role} inputTok: ${item.info && "tokens" in item.info ? (item.info as AssistantMessage).tokens?.input : 0} outputTok: ${item.info && "tokens" in item.info ? (item.info as AssistantMessage).tokens?.output : 0}`)
        if (role !== "assistant") continue

        const info = item.info as AssistantMessage
        const inputTok: number = info.tokens?.input ?? 0
        const cacheReadTok: number = info.tokens?.cache?.read ?? 0
        const outputTok: number = info.tokens?.output ?? 0
        if (inputTok === 0 && cacheReadTok === 0 && outputTok === 0) continue

        const prevSnapshot = processedAssistantMessages.get(msgId) ?? { input: 0, cacheRead: 0, output: 0, cost: 0 }
        const deltaInput = Math.max(0, inputTok - prevSnapshot.input)
        const deltaCacheRead = Math.max(0, cacheReadTok - prevSnapshot.cacheRead)
        const deltaOutput = Math.max(0, outputTok - prevSnapshot.output)
        const deltaCost = Math.max(0, (info.cost ?? 0) - prevSnapshot.cost)
        if (deltaInput === 0 && deltaCacheRead === 0 && deltaOutput === 0 && deltaCost === 0) continue

        processedAssistantMessages.set(msgId, { input: inputTok, cacheRead: cacheReadTok, output: outputTok, cost: info.cost ?? 0 })

        updatePeakContext(sessionID, inputTok, cacheReadTok, outputTok)
        setTotalOutputTokens((prev) => prev + deltaOutput)
        setTotalCacheReadTokens((prev) => prev + deltaCacheRead)
        setTotalNonCachedInputTokens((prev) => prev + deltaInput)
        if (deltaCost > 0) {
          const { inputCost, outputCost } = splitCost(
            deltaInput, deltaCacheRead, deltaOutput, deltaCost,
            info.modelID ?? "",
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

  async function loadRelatedSessionTokens(sessionID: string) {
    if (loadedTokenRootSessionID !== sessionID) {
      resetTokenTracking(sessionID)
    }
    const gen = currentTokenGen

    if (!trackedSessions.has(sessionID)) {
      trackedSessions.add(sessionID)
      loadSessionTokens(sessionID)
    }

    const alreadyWalked = loadedAllSessionsForRoot === sessionID
    if (!alreadyWalked) {
      loadedAllSessionsForRoot = sessionID
      try {
        const sessionList = await props.api.client.session.list({ limit: 200 })
        if (!loadGuard.isCurrent(gen)) return
        const allSessions: Array<{ id?: string; sessionID?: string; parentID?: string; info?: { parentID?: string } }> = Array.isArray(sessionList) ? sessionList : ((sessionList as any)?.data ?? (sessionList as any)?.[200] ?? [])
        let changed = true
        while (changed) {
          changed = false
          for (const s of allSessions) {
            const sid = s.id
            const pid = s.parentID
            if (!sid || trackedSessions.has(sid)) continue
            if (pid && trackedSessions.has(pid)) {
              trackedSessions.add(sid)
              loadSessionTokens(sid)
              changed = true
            }
          }
        }
      } catch (err) {
        log("session.list error:", String(err))
      }
    }
  }

  return {
    peakInputTokens, totalOutputTokens, totalInputCost, totalOutputCost,
    totalCacheReadTokens, totalNonCachedInputTokens,
    setTotalOutputTokens, setTotalCacheReadTokens, setTotalNonCachedInputTokens,
    setTotalInputCost, setTotalOutputCost,
    processedAssistantMessages, peakPerSession, trackedSessions,
    resetTokenTracking, updatePeakContext, loadRelatedSessionTokens,
    loadSessionTokens,
  }
}

// ─── Quota fetching hook ──────────────────────────────────────────────────────

function useQuotaFetching(props: { api: TuiPluginApi; sessionID: string; githubToken: string; hasToken: boolean; currentModel: () => string | null }) {
  const [quotaInfo, setQuotaInfo] = createSignal<CopilotQuotaInfo | null>(null)
  const [quotaLoading, setQuotaLoading] = createSignal<boolean>(false)
  const [goQuota, setGoQuota] = createSignal<GoQuotaInfo | null>(null)
  const [goQuotaLoading, setGoQuotaLoading] = createSignal(false)

  let lastQuotaFetchAt = 0  // timestamp of last event-driven fetchQuota call

  const guardedFetchQuota = withGuard(async () => {
    if (!props.hasToken) {
      log("fetchQuota: no GITHUB_TOKEN set")
      setQuotaInfo(null)
      setQuotaLoading(false)
      return
    }
    log("fetchQuota: starting, token length:", props.githubToken.length)
    lastQuotaFetchAt = Date.now()
    // Only show loading on initial fetch — keep old data visible during refresh
    if (!quotaInfo()) setQuotaLoading(true)
    try {
      const info = await fetchQuotaInfo(props.githubToken)
      log("fetchQuota: got info:", JSON.stringify(info))
      setQuotaInfo(info)
    } finally {
      setQuotaLoading(false)
    }
  })

  const guardedFetchGoQuota = withGuard(async () => {
    setGoQuotaLoading(true)
    try {
      const info = await fetchGoQuota()
      setGoQuota(info)
    } finally {
      setGoQuotaLoading(false)
    }
  })

  const fetchQuota = guardedFetchQuota
  const fetchGoQuotaGuarded = guardedFetchGoQuota

  const isCopilotActive = createMemo(() => props.currentModel()?.toLowerCase().includes("copilot") ?? false)
  const isOpenCodeGoActive = createMemo(() => props.currentModel()?.toLowerCase().includes("opencode-go") ?? false)

  // Quota refresh intervals — registered once so they are not cancelled and
  // recreated on every reactive re-run (every message update).
  const refreshInterval = setInterval(() => {
    fetchQuota()
  }, QUOTA_REFRESH_MS)

  const goRefreshInterval = setInterval(() => {
    if (props.currentModel()?.toLowerCase().includes("opencode-go")) {
      fetchGoQuotaGuarded()
    }
  }, QUOTA_REFRESH_MS)

  onCleanup(() => {
    clearInterval(refreshInterval)
    clearInterval(goRefreshInterval)
  })

  return {
    quotaInfo, quotaLoading, goQuota, goQuotaLoading,
    fetchQuota, fetchGoQuotaGuarded,
    getLastQuotaFetchAt: () => lastQuotaFetchAt,
    isCopilotActive, isOpenCodeGoActive,
  }
}

// ─── Sidebar component ────────────────────────────────────────────────────────

function UsageSidebar(props: { api: TuiPluginApi; session_id: string }) {
  log("UsageSidebar: rendering! session_id:", props.session_id)
  const githubToken = process.env.GITHUB_TOKEN ?? ""
  const hasToken = !!githubToken

  const [activeModel, setActiveModel] = createSignal<string | null>(null)

  // Reactive model detection: re-runs when config.model or session changes
  // api.state is SolidJS-backed, so property access creates reactive dependencies
  const currentModel = createMemo(() => {
    props.api.state.config?.model // track model changes
    return getActiveModel(props.api, props.session_id)
  })

  const tokenTracking = useTokenTracking({ api: props.api, sessionID: props.session_id })
  const {
    peakInputTokens, totalOutputTokens, totalInputCost, totalOutputCost,
    totalCacheReadTokens, totalNonCachedInputTokens,
    setTotalOutputTokens, setTotalCacheReadTokens, setTotalNonCachedInputTokens,
    setTotalInputCost, setTotalOutputCost,
    processedAssistantMessages, peakPerSession, trackedSessions,
    resetTokenTracking, updatePeakContext, loadRelatedSessionTokens,
    loadSessionTokens,
  } = tokenTracking

  const {
    quotaInfo, quotaLoading, goQuota, goQuotaLoading,
    fetchQuota, fetchGoQuotaGuarded,
    getLastQuotaFetchAt,
    isCopilotActive, isOpenCodeGoActive,
  } = useQuotaFetching({
    api: props.api,
    sessionID: props.session_id,
    githubToken,
    hasToken,
    currentModel,
  })

  let loadedQuotaSessionID: string | null = null
  let loadedGoQuotaSessionID: string | null = null

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

    // Determine if this is the root/primary session (no parentID) or a subagent session.
    let isRootSession = true
    props.api.client.session.list({ limit: 200 })
      .then((result) => {
        const sessions: Array<{ id?: string; sessionID?: string; parentID?: string; info?: { parentID?: string } }> = Array.isArray(result) ? result : ((result as any)?.data ?? (result as any)?.[200] ?? [])
        const session = sessions.find((s) => s.id === sessionID)
        const parentID = session?.parentID
        isRootSession = !parentID
        log("createEffect: sessionID:", sessionID, "parentID:", parentID, "isRootSession:", isRootSession)
      })
      .catch(() => { /* keep optimistic true */ })

    const model = currentModel()
    setActiveModel(model)
    log("createEffect: sessionID:", sessionID, "model:", model, "isSupported:", model ? isSupportedModel(model) : false)

    if (model && isSupportedModel(model)) {
      loadRelatedSessionTokens(sessionID) // works for both
      if (model.toLowerCase().includes("copilot")) {
        // Copilot: fetch quota on session change
        if (loadedQuotaSessionID !== sessionID) {
          fetchQuota()
          loadedQuotaSessionID = sessionID
        }
      }
      if (model.toLowerCase().includes("opencode-go")) {
        // opencode-go: fetch go quota once per session change
        if (loadedGoQuotaSessionID !== sessionID) {
          loadedGoQuotaSessionID = sessionID
          fetchGoQuotaGuarded()
        }
      }
    }

    const unsubMessageAll = props.api.event.on("message.updated", (event) => {
      try {
        const e = event as EventMessageUpdated
        const evtSID = e.properties.sessionID
        const msg = e.properties.info

        // --- Token cost counting (assistant messages, all tracked sessions) ---
        if (trackedSessions.has(evtSID) && msg.role === "assistant") {
          const info = msg as AssistantMessage
          const msgId = info.id
            if (msgId) {
              const inputTok: number = info.tokens?.input ?? 0
              const cacheReadTok: number = info.tokens?.cache?.read ?? 0
              const outputTok: number = info.tokens?.output ?? 0
              const msgCost: number = info.cost ?? 0
              if (inputTok > 0 || cacheReadTok > 0 || outputTok > 0 || msgCost > 0) {
                log("message.updated: msgId:", msgId, "session:", evtSID, "provider:", info.providerID, "model:", info.modelID, "input:", inputTok, "cacheRead:", cacheReadTok, "output:", outputTok, "cost:", msgCost, "tokens:", JSON.stringify(info.tokens))
              const prevSnapshot = processedAssistantMessages.get(msgId) ?? { input: 0, cacheRead: 0, output: 0, cost: 0 }
              const deltaInput = Math.max(0, inputTok - prevSnapshot.input)
              const deltaCacheRead = Math.max(0, cacheReadTok - prevSnapshot.cacheRead)
              const deltaOutput = Math.max(0, outputTok - prevSnapshot.output)
              const deltaCost = Math.max(0, msgCost - prevSnapshot.cost)
              if (deltaInput > 0 || deltaCacheRead > 0 || deltaOutput > 0 || deltaCost > 0) {
                processedAssistantMessages.set(msgId, { input: inputTok, cacheRead: cacheReadTok, output: outputTok, cost: msgCost })
                updatePeakContext(evtSID, inputTok, cacheReadTok, outputTok)
                setTotalOutputTokens((prev) => prev + deltaOutput)
                setTotalCacheReadTokens((prev) => prev + deltaCacheRead)
                setTotalNonCachedInputTokens((prev) => prev + deltaInput)
                if (deltaCost > 0) {
                  const { inputCost, outputCost } = splitCost(
                    deltaInput, deltaCacheRead, deltaOutput, deltaCost,
                    info.modelID,
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
      const e = evt as EventSessionCompacted
      const evtSID = e.properties.sessionID

      // Refresh quota only for root session compaction
      if (evtSID === sessionID) {
        if (isRootSession && Date.now() - getLastQuotaFetchAt() > QUOTA_EVENT_MIN_INTERVAL_MS) {
          fetchQuota()
          log("session.compacted: quota refreshed, sessionID:", sessionID)
        } else {
          log("session.compacted: quota fetch skipped (subagent or too recent), sessionID:", sessionID)
        }
      }

      // Token costs: when any tracked session is compacted, the old assistant messages are
      // replaced by a compaction summary message. Counting both would double-count all tokens.
      // Reset everything and re-fetch from the now-compacted state.
      if (evtSID && trackedSessions.has(evtSID)) {
        log("session.compacted: resetting token tracking due to compaction in session:", evtSID)
        resetTokenTracking(sessionID)
        loadRelatedSessionTokens(sessionID)
      }
    })

    const unsubSessionCreated = props.api.event.on("session.created", (event: EventSessionCreated) => {
      const { sessionID: newSID, info } = event.properties
      const parentID = info?.parentID
      if (!newSID || trackedSessions.has(newSID)) return
      if (parentID && trackedSessions.has(parentID)) {
        log("session.created: new child session:", newSID, "parent:", parentID)
        trackedSessions.add(newSID)
        loadSessionTokens(newSID)
      }
    })

    onCleanup(() => {
      unsubMessageAll()
      unsubCompacted()
      unsubSessionCreated()
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

  const cacheHitRate = createMemo(() => {
    const cacheRead = totalCacheReadTokens()
    const nonCached = totalNonCachedInputTokens()
    const total = cacheRead + nonCached
    if (total === 0) return null
    return Math.round((cacheRead / total) * 100)
  })

  log("UsageSidebar: render, isSupported:", isSupported(), "activeModel:", currentModel())

  const theme = props.api.theme.current as Theme

  return (
    <box flexDirection="column" gap={0}>
      {isSupported() ? (
        <>
          <text fg={theme?.text ?? "#ffffff"}><strong>{providerLabel()}</strong></text>
          <text fg={theme?.textMuted ?? "#888888"}>Cost estimation</text>
          <text fg="#ffffff">{("↑ " + peakInputTokens().toLocaleString() + " tokens").padEnd(26) + "$" + totalInputCost().toFixed(2)}</text>
          <text fg="#ffffff">{("↓ " + totalOutputTokens().toLocaleString() + " tokens").padEnd(26) + "$" + totalOutputCost().toFixed(2)}</text>
          {cacheHitRate() !== null ? (
            <text fg="#ffffff">
              {cacheHitRate() + "% cache hit"}
            </text>
          ) : null}
          <text fg={theme?.text ?? "#ffffff"}>
            {"Total".padEnd(26) + "$" + (totalInputCost() + totalOutputCost()).toFixed(2)}
          </text>
          {isCopilotActive() ? (
            <>
              <text fg={theme?.textMuted ?? "#888888"}>Monthly quota</text>
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
              <text fg={theme?.textMuted ?? "#888888"}>Quota</text>
              {!goQuota() && goQuotaLoading() ? (
                <text fg="#888888">Loading...</text>
              ) : goQuota() ? (
                /* If all three bars are null or at 0%, the web page couldn't authenticate */
                (goQuota()!.rolling?.usagePercent ?? 0) === 0 &&
                (goQuota()!.weekly?.usagePercent ?? 0) === 0 &&
                (goQuota()!.monthly?.usagePercent ?? 0) === 0 ? (
                  <box flexDirection="column" gap={0}>
                    <text fg="#eab308">⚠ Unable to fetch Go quota</text>
                    <text fg={theme?.textMuted ?? "#888888"}>Set OPENCODE_GO_AUTH_COOKIE with your browser's auth cookie</text>
                  </box>
                ) : (
                  <box flexDirection="column" gap={0}>
                    <text fg={theme?.textMuted ?? "#888888"}>Rolling (5h)</text>
                    <text fg={getUsageColor(goQuota()!.rolling?.usagePercent ?? 0)}>
                      {goQuota()!.rolling?.usagePercent ?? 0}% · resets in {formatDuration(goQuota()!.rolling?.resetInSec ?? 0)}
                    </text>
                    <text fg={getUsageColor(goQuota()!.rolling?.usagePercent ?? 0)}>
                      {buildProgressBar(goQuota()!.rolling?.usagePercent ?? 0)}
                    </text>
                    <text fg={theme?.textMuted ?? "#888888"}>Weekly</text>
                    <text fg={getUsageColor(goQuota()!.weekly?.usagePercent ?? 0)}>
                      {goQuota()!.weekly?.usagePercent ?? 0}% · resets in {formatDuration(goQuota()!.weekly?.resetInSec ?? 0)}
                    </text>
                    <text fg={getUsageColor(goQuota()!.weekly?.usagePercent ?? 0)}>
                      {buildProgressBar(goQuota()!.weekly?.usagePercent ?? 0)}
                    </text>
                    <text fg={theme?.textMuted ?? "#888888"}>Monthly</text>
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
