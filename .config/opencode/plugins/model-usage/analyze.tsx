/** @jsxImportSource @opentui/solid */
import type { TuiPluginApi } from "@opencode-ai/plugin/tui"
import { onMount, onCleanup, createSignal, createMemo } from "solid-js"
import { existsSync, readFileSync } from "node:fs"
import { homedir } from "node:os"
import { log } from "./helpers/debug"
import { estimateTokens, rawPromptTokens, scaleEntries, estimateVisibleOutputTokens } from "./helpers/tokens"
import { buildBar, fmt, truncateLabel, fmtCompact, fmtCost, PREVIEW_MAX_LEN } from "./helpers/format"
import { writeClipboard } from "./helpers/clipboard"
import { resolveCompactionEvents } from "./helpers/compaction"
import type { CompactionSummary } from "./helpers/compaction"
import { detectHotspots, pickPreview, summarizeToolInput, shortenPath } from "./helpers/hotspots"
import { computeModelsTabLayout, countModelSwitches } from "./helpers/model-tab"
import type { HotspotCandidate, HotspotResult } from "./helpers/hotspots"
import { aggregateModelStats } from "./helpers/models"
import type { ModelUsageRecord, ModelStat } from "./helpers/models"
import { calcCacheHitRate } from "./helpers/cost"
import { splitSystemFragments } from "./helpers/fragments"
import { loadBaseline } from "./db"
import type { SystemFragment, SystemSnapshot, SystemSource } from "./types"
import { makeScrollState } from "./shared/scroll"
import { registerDialogKeyLayer } from "./shared/keys"
import { createLoadGuard } from "./shared/reload"
import type { AssistantMessage, Message, Part, SessionMessagesResponse } from "@opencode-ai/sdk/v2"

interface ThemeColors {
  foreground?: string
  muted?: string
  red?: string
  primary?: string
  selectedListItemText?: string
}

interface CategoryEntry {
  label: string
  tokens: number
}

interface Category {
  name: string
  entries: CategoryEntry[]
  totalTokens: number
}

interface FormattedHotspotResult extends HotspotResult {
  formattedRatio: string
}

export function registerAnalyzeCommand(api: TuiPluginApi) {
  api.keymap.registerLayer({
    commands: [
      {
        name: "analyze.show",
        title: "Analyze Session Tokens",
        category: "Plugin",
        namespace: "palette",
        slashName: "analyze",
        async run() {
          // ── Get current session ID from route ─────────────────────────────
          const route = api.route.current
          const currentSessionID = route.name === "session"
            ? (route as any).params?.sessionID
            : undefined

          if (!currentSessionID) {
            api.ui.dialog.replace(() => {
              onMount(() => { api.ui.dialog.setSize("medium") })
              const fg = api.theme.current?.foreground ?? "#ffffff"
              const muted = api.theme.current?.muted ?? "#888888"
              return (
                <box paddingLeft={2} paddingRight={2} paddingBottom={1} flexDirection="column" gap={1}>
                  <box flexDirection="row" justifyContent="space-between">
                    <box flexDirection="row" gap={1}>
                      <text fg={fg}><b>Analyze</b></text>
                      <text fg={muted}>— No active session</text>
                    </box>
                    <text fg={muted}>esc</text>
                  </box>
                  <text fg={muted}>Open a session to analyze its token usage.</text>
                </box>
              )
            })
            return
          }

          // ── Derived values ───────────────────────────────────────────────
          const theme = api.theme.current
          const fg = theme?.text ?? "#ffffff"
          const muted = theme?.textMuted ?? "#888888"
          const red = theme?.error ?? "#ef4444"
          const primary = (theme as ThemeColors)?.primary
          const selectedText = (theme as ThemeColors)?.selectedListItemText
          const BAR_WIDTH = 50
          const sidDisplay = currentSessionID.length > 8
            ? currentSessionID.slice(0, 8) + "…"
            : currentSessionID

          // ── State ─────────────────────────────────────────────────────────
          const [loading, setLoading] = createSignal(true)
          const [errorMsg, setErrorMsg] = createSignal("")
          const [categories, setCategories] = createSignal<Category[]>([])
          const [estimatedTotal, setEstimatedTotal] = createSignal<number>(0)
          const [topContributors, setTopContributors] = createSignal<CategoryEntry[]>([])
          const [hasToolsSection, setHasToolsSection] = createSignal(false)
          const [messageCount, setMessageCount] = createSignal<number>(0)
          const [activeTab, setActiveTab] = createSignal(0)
          const [showRaw, setShowRaw] = createSignal(false)
          const [rawSystemText, setRawSystemText] = createSignal("")
          const [modelStats, setModelStats] = createSignal<ModelStat[]>([])
          const [switchesCount, setSwitchesCount] = createSignal<number>(0)
          const [compactionSummary, setCompactionSummary] = createSignal<CompactionSummary | null>(null)
          const [sessionCost, setSessionCost] = createSignal<number>(0)
          const [hotspotResults, setHotspotResults] = createSignal<FormattedHotspotResult[]>([])
          const [expandedHotspotIndex, setExpandedHotspotIndex] = createSignal<number | null>(null)
          const [copiedFlash, setCopiedFlash] = createSignal<boolean>(false)

          let pollInterval: any = null
          let cleanupKeyLayer: (() => void) | null = null
          let copiedTimeout: any = null
          const scroll = makeScrollState(createSignal)
          const loadGuard = createLoadGuard()

          // ── Tabs ─────────────────────────────────────────────────────────
          // Dynamic tab list — only show tabs that have data. The memo reads
          // the data signals so it updates reactively when categories change.
          const tabs = createMemo(() => {
            const t: { id: string; label: string }[] = [{ id: "context", label: "Context" }]
            if (hasToolsSection()) t.push({ id: "tools", label: "Per-Tool" })
            const sysCat = categories().find((c: Category) => c.name.startsWith("SYSTEM"))
            if (sysCat && sysCat.entries.length >= 2) t.push({ id: "system", label: "System" })
            if (modelStats().length > 1) t.push({ id: "models", label: "Models" })
            t.push({ id: "extra", label: "Extra Info" })
            return t
          })

          function switchTab(dir: number) {
            const list = tabs()
            if (list.length <= 1) return
            setActiveTab((t) => {
              const next = t + dir
              if (next < 0) return list.length - 1
              if (next >= list.length) return 0
              return next
            })
            // Reset scroll to top on tab switch.
            scroll.scrollToTop()
            setShowRaw(false)
            // Re-check overflow after tab switch (different content heights).
            setTimeout(() => scroll.checkOverflow(), 50)
          }

          // ── Key handler ───────────────────────────────────────────────────
          function handleKey(key: string) {
            if (key === "up") {
              return scroll.handleUp()
            }
            if (key === "down") {
              return scroll.handleDown()
            }
            return false
          }

          // ── Load system snapshot from server plugin (Tier 3) ──────────────
          // Reads the LATEST measurement persisted by model-usage-server.ts.
          // Returns {total (char/4), fragments, ts} or null when the server
          // plugin has never fired for this session (e.g. cold start, V2-only).
          function loadSystemSnapshot(sessionID: string): SystemSnapshot | null {
            const file = `${homedir()}/.config/opencode/plugins/model-usage/system-tokens.json`
            log("loadSystemSnapshot: checking file:", file)
            try {
              const exists = existsSync(file)
              log("loadSystemSnapshot: file exists:", exists)
              if (!exists) return null
              const raw = readFileSync(file, "utf-8")
              log("loadSystemSnapshot: raw length:", raw.length)
              const data = JSON.parse(raw) as Record<string, SystemSnapshot>
              const keys = Object.keys(data)
              log("loadSystemSnapshot: parsed, keys count:", keys.length, "sessionID:", sessionID)
              if (keys.length <= 5) {
                log("loadSystemSnapshot: all keys:", keys.join(", "))
              }
              const entry = data[sessionID]
              log("loadSystemSnapshot: entry for session:", entry ? JSON.stringify(entry).slice(0, 200) : "NOT FOUND")
              if (entry && typeof entry.t === "number") {
                log("loadSystemSnapshot: returning t =", entry.t, "fragments:", entry.fragments?.length ?? 0)
                return entry
              }
              log("loadSystemSnapshot: entry.t not a number or missing, returning null")
            } catch (err) {
              log("loadSystemSnapshot: error:", String(err))
            }
            return null
          }

          // ── Tier 1: V2 baseline DB ────────────────────────────────────────
          // The V2 native runner persists the full assembled system prompt to
          // `session_context_epoch.baseline` on every turn. This is the exact
          // text — we tokenise with char/4. Returns null on V1 (table empty)
          // or older builds (table absent).
          function loadBaselineTokens(sessionID: string): number | null {
            const dbPath = `${homedir()}/.local/share/opencode/opencode.db`
            if (!existsSync(dbPath)) return null
            const baseline = loadBaseline(dbPath, sessionID)
            if (!baseline) return null
            const t = estimateTokens(baseline)
            log("loadBaselineTokens: hit, baseline chars =", baseline.length, "→ tokens", t)
            return t
          }

          // ── Data loader ───────────────────────────────────────────────────
          async function loadAnalysis() {
            const gen = loadGuard.invalidate()
            try {
              const result = await api.client.session.messages({
                sessionID: currentSessionID,
                limit: 10000,
              })
              // Stale-load guard: a newer reload() incremented the counter,
              // meaning this fetch is superseded — discard its results.
              if (!loadGuard.isCurrent(gen)) { log("analyze: stale fetch, discarding"); return }
              const apiResult = result as SessionMessagesResponse
              const messages: Array<{ id?: string; info: Message; parts: Part[] }> = Array.isArray(apiResult.data) ? apiResult.data as any : []
              setMessageCount(messages.length)
              log("=== analyze: loaded", messages.length, "messages for session", currentSessionID, "===")

              if (messages.length === 0) {
                setLoading(false)
                return
              }

              // ── Process messages ──────────────────────────────────────────
              const userEntries: CategoryEntry[] = []
              const assistantEntries: CategoryEntry[] = []
              const toolMap = new Map<string, number>()
              const reasoningEntries: CategoryEntry[] = []
              let userCounter = 0
              let assistantCounter = 0
              let reasoningCounter = 0

              const modelUsageRecords: ModelUsageRecord[] = []
              const userCandidates: HotspotCandidate[] = []
              const toolsCandidates: HotspotCandidate[] = []

              const makePreview = (text: string) => {
                const trimmed = text.trim()
                return trimmed.length > PREVIEW_MAX_LEN ? trimmed.slice(0, PREVIEW_MAX_LEN).trim() + "…" : trimmed
              }
              const makeFullText = (text: string) => {
                return text.length > 5000 ? text.slice(0, 5000) + "\n\n… (truncated at 5000 chars)" : text
              }

              // Total tokens of ALL conversation content (user + assistant +
              // tool output + tool call args + reasoning + file content)
              // processed BEFORE the first nonzero-input assistant. Subtracted
              // from the raw prompt tokens to isolate the system prompt.
              // For the first call this is just the user message(s); for a
              // hypothetical later call it includes prior assistant/tools too.
              let conversationTokensBeforeFirstAssistant: number | null = null
              // First assistant message with non-zero tokens.input — used for
              // the Tier 2 telemetry subtraction. A title-generator assistant
              // (tokens.input === 0) is skipped.
              let firstNonzeroAssistant: any = null
              // sessionWasCompacted derived from resolveCompactionEvents after the loop
              let sessionWasCompacted = false
              // Per-message telemetry sum for reasoning tokens (provider-reported,
              // exact). Used to scale the REASONING category's char/4 entries.
              let reasoningTelemetry = 0
              const serverSnapshot = loadSystemSnapshot(currentSessionID)
              const baselineTokens = loadBaselineTokens(currentSessionID)
              setRawSystemText(serverSnapshot?.rawText ?? "")
              log("analyze: serverSnapshot =", serverSnapshot ? `t=${serverSnapshot.t} frags=${serverSnapshot.fragments?.length ?? 0}` : "null")
              log("analyze: baselineTokens (Tier 1) =", baselineTokens)

              for (const msg of messages) {
                const info = msg.info as Message
                if (info.role !== "assistant" && info.role !== "user") continue
                const parts: any[] = (msg.parts ?? []) as any[]
                const msgId = msg.id ?? (info as any)?.id
                log("analyze: msg", msgId, "role:", info.role, "parts:", parts.length)

                // Check for compaction part (signals a compaction summary message)
                const hasCompaction = parts.some((p: any) => p.type === "compaction")

                // ── Model Usage Records Ledger (Genuine full ledger, all assistant messages) ──
                if (info.role === "assistant") {
                  const asstInfo = info as unknown as AssistantMessage
                  const providerID = asstInfo.providerID
                  const modelID = asstInfo.modelID
                  if (providerID && modelID) {
                    // Compute the reconstructed raw prompt size for this individual call.
                    // This is provider-agnostic, restoring the cache counters subtracted by OpenCode.
                    const currentRawPrompt = rawPromptTokens({
                      input: asstInfo.tokens?.input ?? 0,
                      cache: {
                        read: asstInfo.tokens?.cache?.read ?? 0,
                        write: asstInfo.tokens?.cache?.write ?? 0,
                      },
                    })

                    // Skip degenerate zero-telemetry records entirely (e.g. aborted/interrupted/stub calls)
                    // so they do not count toward message counts or overwrite valid raw prompt token statistics.
                    const hasTelemetry = currentRawPrompt > 0 || (asstInfo.tokens?.output ?? 0) > 0 || (asstInfo.tokens?.reasoning ?? 0) > 0 || (asstInfo.cost ?? 0) > 0

                    const partCounts: Record<string, number> = {}
                    for (const p of parts) {
                      const t = p.type || "unknown"
                      partCounts[t] = (partCounts[t] || 0) + 1
                    }
                    const hasNonEmptyTextPart = parts.some((p: any) => p.type === "text" && typeof p.text === "string" && p.text.length > 0)
                    const visibleOutputTokens = estimateVisibleOutputTokens(parts)

                    log(
                      `[ledger diagnostic] msgId: ${msgId} | providerID/modelID: ${providerID}/${modelID} | rawTokens: ${JSON.stringify(asstInfo.tokens ?? {})} | cost: ${asstInfo.cost ?? 0} | currentRawPrompt: ${currentRawPrompt} | hasTelemetry: ${hasTelemetry} | action: ${hasTelemetry ? "pushed" : "skipped"} | partsBreakdown: ${JSON.stringify(partCounts)} | hasNonEmptyTextPart: ${hasNonEmptyTextPart} | visibleOutputTokens: ${visibleOutputTokens}`
                    )

                    if (hasTelemetry) {
                      modelUsageRecords.push({
                        providerID,
                        modelID,
                        inputTokens: asstInfo.tokens?.input ?? 0,
                        outputTokens: asstInfo.tokens?.output ?? 0,
                        cacheRead: asstInfo.tokens?.cache?.read ?? 0,
                        cacheWrite: asstInfo.tokens?.cache?.write ?? 0,
                        cost: asstInfo.cost ?? 0,
                        visibleOutputTokens: visibleOutputTokens,
                        // We track the raw prompt size per call. When aggregated, we only keep the
                        // chronologically last call's raw prompt size (not the sum of raw prompts across turns).
                        // This avoids the double-counting trap where the same accumulated context gets counted on
                        // every single turn, and reflects the true scale of the conversation's active state.
                        // This mirrors the Tier-2 SYSTEM resolution's use of a single representative raw prompt.
                        lastCallRawPromptTokens: currentRawPrompt,
                        // Per-model peak context (input + cacheRead, matching sidebar convention).
                        // Used for the ↑ display in the Models tab.
                        peakInputTokens: (asstInfo.tokens?.input ?? 0) + (asstInfo.tokens?.cache?.read ?? 0),
                      })
                    }
                  }
                }

                // ── User messages ───────────────────────────────────────────
                if (info.role === "user") {
                  // Skip compaction-summary synthetic messages
                  if (hasCompaction) { log("analyze: SKIP user msg", msgId, "- has compaction part"); continue }

                  // Skip messages where ALL text parts are synthetic
                  const textParts = parts.filter((p: any) => p.type === "text")
                  const allSynthetic = textParts.length > 0
                    && textParts.every((p: any) => p.synthetic === true)
                  if (allSynthetic) { log("analyze: SKIP user msg", msgId, "- all text parts are synthetic"); continue }

                  // Extract text from non-synthetic text parts
                  let text = ""
                  for (const part of parts) {
                    if (part.type === "text" && !part.synthetic) {
                      text += part.text ?? ""
                    }
                  }
                  // Also extract text from file parts
                  for (const part of parts) {
                    if (part.type === "file") {
                      const fileText = part.source ?? part.content ?? part.text ?? ""
                      if (fileText.length > 0) {
                        text += fileText
                      }
                    }
                  }
                  if (text.trim().length === 0) continue

                  userCounter++
                  log("analyze: COUNT user msg", msgId, "-", text.length, "chars ->", estimateTokens(text), "estimated tokens (User #" + userCounter + ")")
                  const tokensCount = estimateTokens(text)
                  userEntries.push({
                    label: `User #${userCounter}`,
                    tokens: tokensCount,
                  })
                  userCandidates.push({
                    category: "USER",
                    label: `User #${userCounter}`,
                    tokens: tokensCount,
                    preview: makePreview(text),
                    fullText: makeFullText(text),
                  })
                }

                // ── Assistant messages ──────────────────────────────────────
                if (info.role === "assistant") {
                  if (hasCompaction) { log("analyze: SKIP assistant msg", msgId, "- has compaction part"); continue }

                  // Snapshot ALL conversation tokens at the point of the first
                  // assistant message with non-zero tokens.input. We skip
                  // title-generator assistants (tokens.input === 0) which would
                  // otherwise pollute the telemetry subtraction. The snapshot
                  // must capture tokens accumulated BEFORE this assistant —
                  // hence it's done before any assistant-side counting.
                  if (firstNonzeroAssistant === null && (info.tokens?.input ?? 0) > 0) {
                    firstNonzeroAssistant = msg
                    const userBefore = userEntries.reduce((s, e) => s + e.tokens, 0)
                    const assistantBefore = assistantEntries.reduce((s, e) => s + e.tokens, 0)
                    const toolBefore = Array.from(toolMap.values()).reduce((a, b) => a + b, 0)
                    const reasoningBefore = reasoningEntries.reduce((s, e) => s + e.tokens, 0)
                    conversationTokensBeforeFirstAssistant = userBefore + assistantBefore + toolBefore + reasoningBefore
                    log("analyze: first nonzero assistant", msgId, "conversationBefore =", conversationTokensBeforeFirstAssistant, "(user =", userBefore, "assistant =", assistantBefore, "tool =", toolBefore, "reasoning =", reasoningBefore, ") input =", info.tokens.input, "cache.read =", info.tokens?.cache?.read ?? 0, "cache.write =", info.tokens?.cache?.write ?? 0)
                  }

                  // Accumulate reasoning telemetry (provider-reported, exact).
                  // NOTE: we do NOT use tokens.output for ASSISTANT because it
                  // includes tool-call generation (the JSON the model produces
                  // to invoke tools), which is already counted in TOOLS — using
                  // it would double-count. Reasoning is safe (not elsewhere).
                  const reasonTok = info?.tokens?.reasoning ?? 0
                  reasoningTelemetry += reasonTok

                  const visibleTokens = estimateVisibleOutputTokens(parts)
                  if (visibleTokens > 0) {
                    assistantCounter++
                    log("analyze: COUNT assistant msg", msgId, "-", visibleTokens, "visible tokens (Assistant #" + assistantCounter + ")")
                    assistantEntries.push({
                      label: `Assistant #${assistantCounter}`,
                      tokens: visibleTokens,
                    })
                  }
                }

                // ── Tool parts ──────────────────────────────────────────────
                for (const part of parts) {
                  const toolName = part.tool ?? "unknown"
                  if (part.type === "tool" && part.state?.status === "completed") {
                    const output = part.state?.output ?? ""
                    if (output.length > 0) {
                      const tokensCount = estimateTokens(output)
                      toolMap.set(
                        toolName,
                        (toolMap.get(toolName) ?? 0) + tokensCount,
                      )
                      let previewTitle: string | undefined = undefined
                      const inputResult = summarizeToolInput(toolName, part.state?.input)
                      if (inputResult !== null) {
                        const pathLikeKeys = ["filePath", "path", "pattern"]
                        if (pathLikeKeys.includes(inputResult.key) && (inputResult.value.includes("/") || inputResult.value.includes("\\"))) {
                          previewTitle = shortenPath(inputResult.value, 2)
                        } else {
                          previewTitle = inputResult.value
                        }
                      } else {
                        const rawTitle = part.state?.title
                        if (rawTitle) {
                          if (rawTitle.includes("/") || rawTitle.includes("\\")) {
                            previewTitle = shortenPath(rawTitle, 2)
                          } else {
                            previewTitle = rawTitle
                          }
                        }
                      }

                      toolsCandidates.push({
                        category: "TOOLS",
                        label: `Tool: ${toolName}`,
                        tokens: tokensCount,
                        preview: pickPreview(output, previewTitle),
                        fullText: makeFullText(output),
                      })
                    }
                  }
                  // Also count tool call arguments (the JSON the model sends to invoke the tool)
                  if (part.type === "tool") {
                    const callInput = part.state?.input ?? part.arguments ?? part.call?.arguments
                    if (callInput) {
                      const inputText = typeof callInput === "string" ? callInput : JSON.stringify(callInput)
                      if (inputText.length > 0) {
                        const tokensCount = estimateTokens(inputText)
                        toolMap.set(
                          toolName,
                          (toolMap.get(toolName) ?? 0) + tokensCount,
                        )
                        toolsCandidates.push({
                          category: "TOOLS",
                          label: `Tool Call: ${toolName}`,
                          tokens: tokensCount,
                          preview: makePreview(inputText),
                          fullText: makeFullText(inputText),
                        })
                      }
                    }
                  }
                }
                if (toolMap.size > 0) {
                  log("analyze: msg", msgId, "tool output total:", Array.from(toolMap.values()).reduce((a,b) => a+b, 0), "estimated tokens across", toolMap.size, "tools")
                }

                // ── Reasoning parts ─────────────────────────────────────────
                for (const part of parts) {
                  if (part.type === "reasoning") {
                    const text = part.text ?? ""
                    if (text.trim().length > 0) {
                      reasoningCounter++
                      log("analyze: COUNT reasoning msg", msgId, "-", text.length, "chars ->", estimateTokens(text), "estimated tokens (Reasoning #" + reasoningCounter + ")")
                      reasoningEntries.push({
                        label: `Reasoning #${reasoningCounter}`,
                        tokens: estimateTokens(text),
                      })
                    }
                  }
                }
              }

              // ── Resolve compaction events ─────────────────────────────────
              // Pure function extracts compaction events from the raw message
              // stream, resolving before/after tokens from adjacent assistant
              // rawPromptTokens. Multi-consecutive-compaction limitation doc:
              // if two compactions happen with no assistant between them, the
              // second compaction's `before` reuses the first's prior assistant
              // value (stale). This is rare and acceptable.
              const { events: resolvedCompactionEvents, summary: resolvedCompactionSummary } = resolveCompactionEvents(messages)
              if (resolvedCompactionEvents.length > 0) {
                sessionWasCompacted = true
                setCompactionSummary(resolvedCompactionSummary)
                log("analyze: compaction summary:", JSON.stringify(resolvedCompactionSummary))
              }

              // ── Build categories ──────────────────────────────────────────
              const cats: Category[] = []

              // ── SYSTEM token resolution (tiered, provider-agnostic) ───────
              // Tier 1: V2 baseline DB (exact text, char/4).
              // Tier 2: first nonzero assistant telemetry, ONLY when clean
              //         (cache.read === 0 on that call). Formula reconstitutes
              //         the raw prompt: system = raw − user − tools, where
              //         raw = tokens.input + cache.read + cache.write.
              //         OpenCode stores tokens.input already adjusted
              //         (session.ts:366), so we must ADD cache counters back.
              // Tier 3 (contaminated/compacted): server plugin snapshot
              //         (char/4, latest), with ⚠.
              // Tier 4 (last resort): 0 — no system data available.
              let systemTokens: number = 0
              let systemSource: SystemSource | null = null
              const serverTotal = serverSnapshot?.t ?? null
              // Re-split from rawText with the current splitSystemFragments logic.
              // This makes fragment display immune to stale server-cached fragments
              // (the server plugin may not re-capture on every restart if the system prompt
              // hasn't changed materially, leaving old pre-PR#39 fragments in system-tokens.json).
              const rawSysText = serverSnapshot?.rawText
              const serverFrags: SystemFragment[] = rawSysText
               ? splitSystemFragments(rawSysText)
               : (serverSnapshot?.fragments ?? [])

              if (baselineTokens !== null) {
                // Tier 1 — V2 baseline DB.
                systemTokens = baselineTokens
                systemSource = "baseline DB"
                log("analyze: SYSTEM Tier 1 (baseline DB) =", systemTokens)
              } else {
                // Tier 2 — telemetry, only when the first nonzero call is clean.
                const info = firstNonzeroAssistant?.info as any
                const inputTok = info?.tokens?.input ?? 0
                const cacheReadTok = info?.tokens?.cache?.read ?? 0
                const cacheWriteTok = info?.tokens?.cache?.write ?? 0
                const conversationBefore = conversationTokensBeforeFirstAssistant ?? 0
                const clean = firstNonzeroAssistant !== null && cacheReadTok === 0
                log("analyze: SYSTEM Tier 2 check: firstNonzero =", !!firstNonzeroAssistant, "input =", inputTok, "cacheRead =", cacheReadTok, "cacheWrite =", cacheWriteTok, "conversationBefore =", conversationBefore, "clean =", clean, "compacted =", sessionWasCompacted)

                if (clean && !sessionWasCompacted) {
                  // Reconstitute raw prompt: input + cache.read + cache.write,
                  // then subtract ALL conversation content that preceded this
                  // assistant (user + assistant + tools + reasoning) to isolate
                  // the system prompt.
                  const raw = rawPromptTokens(info?.tokens ?? {})
                  systemTokens = Math.max(0, raw - conversationBefore)
                  systemSource = "telemetry (est.)"
                  log("analyze: SYSTEM Tier 2 (telemetry) raw =", raw, "conversationBefore =", conversationBefore, "→ system =", systemTokens)
                } else if (serverTotal !== null) {
                  // Tier 3 — contaminated/compacted: server plugin char/4.
                  systemTokens = serverTotal
                  systemSource = "server"
                  log("analyze: SYSTEM Tier 3 (server, contaminated/compacted) =", systemTokens)
                } else {
                  log("analyze: SYSTEM no tier available (0)")
                }
              }

              // Build SYSTEM entries. When we have a Tier 1/2 total AND server
              // fragments, scale the fragments so their sum matches the
              // authoritative total (breakdown = current composition, total =
              // exact). Otherwise show a single row. The source label goes in
              // the category name so the entries' token sum stays consistent
              // with `totalTokens` (no double-counted "Total" row).
              let systemEntries: CategoryEntry[] = []
              let systemName = "SYSTEM"
              if (systemTokens > 0) {
                const warn = systemSource === "server"
                const sourceLabel: string = systemSource ?? "(unknown)"
                systemName = `SYSTEM — ${sourceLabel}${warn ? " ⚠" : ""}`
                if (serverFrags.length > 0 && (systemSource === "baseline DB" || systemSource === "telemetry (est.)")) {
                  // Scale fragments to the authoritative total.
                  systemEntries = scaleEntries(serverFrags, systemTokens).map((f) => ({
                    label: f.label,
                    tokens: f.tokens,
                  }))
                } else {
                  systemEntries = [{
                    label: "System prompt",
                    tokens: systemTokens,
                  }]
                }
                cats.push({
                  name: systemName,
                  entries: systemEntries,
                  totalTokens: systemTokens,
                })
              }
              log("analyze: systemTokens final =", systemTokens, "source =", systemSource, "entries =", systemEntries.length)

              if (userEntries.length > 0) {
                cats.push({
                  name: "USER",
                  entries: userEntries,
                  totalTokens: userEntries.reduce((s, e) => s + e.tokens, 0),
                })
              }

              if (assistantEntries.length > 0) {
                cats.push({
                  name: "ASSISTANT",
                  entries: assistantEntries,
                  totalTokens: assistantEntries.reduce((s, e) => s + e.tokens, 0),
                })
              }

              const toolEntries: CategoryEntry[] = Array.from(toolMap.entries())
                .sort((a, b) => b[1] - a[1])
                .map(([name, tokens]) => ({ label: name, tokens }))
              if (toolEntries.length > 0) {
                cats.push({
                  name: "TOOLS",
                  entries: toolEntries,
                  totalTokens: toolEntries.reduce((s, e) => s + e.tokens, 0),
                })
              }

              if (reasoningEntries.length > 0) {
                // Scale per-part char/4 entries to the provider-reported
                // tokens.reasoning total (exact) when telemetry is available.
                const reasoningTotal = reasoningTelemetry > 0
                  ? reasoningTelemetry
                  : reasoningEntries.reduce((s, e) => s + e.tokens, 0)
                const scaledReasoning = reasoningTelemetry > 0
                  ? scaleEntries(reasoningEntries, reasoningTelemetry)
                  : reasoningEntries
                cats.push({
                  name: "REASONING",
                  entries: scaledReasoning,
                  totalTokens: reasoningTotal,
                })
              }

              // Sort categories by totalTokens descending
              cats.sort((a, b) => b.totalTokens - a.totalTokens)
              const totalEstimated = cats.reduce((s, c) => s + c.totalTokens, 0)
              setEstimatedTotal(totalEstimated)
              log("=== analyze: category summary ===")
              log("  telemetry: reasoning =", reasoningTelemetry)
              for (const cat of cats) {
                log("  ", cat.name, ":", cat.entries.length, "entries,", cat.totalTokens, "estimated tokens")
              }
              log("  TOTAL estimated:", cats.reduce((s, c) => s + c.totalTokens, 0))
              setCategories(cats)
              setHasToolsSection(toolEntries.length > 0)

              // ── Top contributors (all entries, sorted, top 10) ────────────
              const allEntries = cats.flatMap((c) => c.entries)
              const top10 = allEntries
                .filter((e) => e.tokens > 0)
                .sort((a, b) => b.tokens - a.tokens)
                .slice(0, 10)
              setTopContributors(top10)

              // ── Aggregate and set model stats ──
              const stats = aggregateModelStats(modelUsageRecords)
              log("analyze: final aggregated model stats: " + JSON.stringify(stats.map(s => ({
                "providerID/modelID": `${s.providerID}/${s.modelID}`,
                msgCount: s.msgCount,
                inputTokens: s.inputTokens,
                outputTokens: s.outputTokens,
                cacheRead: s.cacheRead,
                cacheWrite: s.cacheWrite,
                cost: s.cost,
                visibleOutputTokens: s.visibleOutputTokens,
                lastCallRawPromptTokens: s.lastCallRawPromptTokens
              }))))
              setModelStats(stats)

              // ── Compute sequential model switches ──
              setSwitchesCount(countModelSwitches(messages))

              // ── Compute session cost ──
              const totalCost = modelUsageRecords.reduce((acc, r) => acc + r.cost, 0)
              setSessionCost(totalCost)

              // ── Detect hotspots ──
              // Scoped to USER and TOOLS categories only (not ASSISTANT, not SYSTEM, not REASONING - intentional per issue spec)
              const candidates: Record<string, HotspotCandidate[]> = {
                USER: userCandidates,
                TOOLS: toolsCandidates,
              }
              const results = detectHotspots(candidates)
              const formattedResults = results.map((res) => ({
                ...res,
                formattedRatio: res.ratio.toFixed(1),
              }))
              setHotspotResults(formattedResults)

              setLoading(false)
              // Check overflow after content renders.
              setTimeout(() => scroll.checkOverflow(), 50)
            } catch (err) {
              setErrorMsg(String(err))
              setLoading(false)
            }
          }

          // ── Manual reload (mid-conversation refresh) ──────────────────────
          // Re-runs loadAnalysis() without closing the dialog. Resets UI state
          // (loading, scroll) so the user sees the update in progress.
          // Manual only — auto-poll uses backgroundReload() below.
          function reload() {
            log("analyze: reload triggered")
            loadGuard.invalidate()
            setShowRaw(false)
            setRawSystemText("")
            setLoading(true)
            // Don't clear data — keep showing the old view while fetching.
            // Mirrors /usage dialog: loading spinner only appears when there's
            // no prior data to display (gated in the render below).
            loadAnalysis()
          }

          // Background (auto-poll) reload: silently re-fetches without
          // nuking the visible data, scroll position, or tab. The
          // loadGeneration guard handles stale-fetch discards.
          const AUTO_POLL_MS = 60_000
          function backgroundReload() {
            log("analyze: background reload")
            loadGuard.invalidate()
            loadAnalysis()
          }

          // ── Reactive dialog ──────────────────────────────────────────────
          api.ui.dialog.replace(() => {
            const toggleExpand = (idx: number) => {
              const list = tabs()
              const currentTab = list[Math.min(activeTab(), list.length - 1)]
              if (currentTab?.id !== "extra") return

              if (idx >= hotspotResults().length) return

              setExpandedHotspotIndex((prev) => (prev === idx ? null : idx))
            }

            const copyRawSystemText = async () => {
              const list = tabs()
              const currentTab = list[Math.min(activeTab(), list.length - 1)]
              if (currentTab?.id !== "system" || !showRaw()) return

              const text = rawSystemText()
              if (!text) return

              const success = await writeClipboard(text)
              if (success) {
                if (copiedTimeout) {
                  clearTimeout(copiedTimeout)
                }
                setCopiedFlash(true)
                copiedTimeout = setTimeout(() => {
                  setCopiedFlash(false)
                  copiedTimeout = null
                }, 2000)
              }
            }

            onMount(() => {
              api.ui.dialog.setSize("large")

              // Register dialog key layer for scroll + tabs + reload
              cleanupKeyLayer = registerDialogKeyLayer(api, {
                bindings: [
                  { key: "up",   cmd: "analyze.scrollUp",   desc: "Scroll up" },
                  { key: "k",    cmd: "analyze.scrollUp",   desc: "Scroll up" },
                  { key: "down", cmd: "analyze.scrollDown", desc: "Scroll down" },
                  { key: "j",    cmd: "analyze.scrollDown", desc: "Scroll down" },
                  { key: "left",  cmd: "analyze.tabLeft",  desc: "Previous tab" },
                  { key: "h",     cmd: "analyze.tabLeft",  desc: "Previous tab" },
                  { key: "right", cmd: "analyze.tabRight", desc: "Next tab" },
                  { key: "l",     cmd: "analyze.tabRight", desc: "Next tab" },
                  { key: "v",     cmd: "analyze.toggleRaw", desc: "Raw prompt" },
                  { key: "c",     cmd: "analyze.copyRaw",    desc: "Copy raw system prompt" },
                  { key: "r",    cmd: "analyze.reload",     desc: "Reload" },
                  { key: "1",    cmd: "analyze.expand1",    desc: "Toggle expand large message 1" },
                  { key: "2",    cmd: "analyze.expand2",    desc: "Toggle expand large message 2" },
                  { key: "3",    cmd: "analyze.expand3",    desc: "Toggle expand large message 3" },
                  { key: "4",    cmd: "analyze.expand4",    desc: "Toggle expand large message 4" },
                  { key: "5",    cmd: "analyze.expand5",    desc: "Toggle expand large message 5" },
                ],
                commands: [
                  { name: "analyze.scrollUp",   title: "Scroll Up",   run: async () => { handleKey("up") } },
                  { name: "analyze.scrollDown", title: "Scroll Down", run: async () => { handleKey("down") } },
                  { name: "analyze.tabLeft",    title: "Previous Tab", run: async () => { switchTab(-1) } },
                  { name: "analyze.tabRight",   title: "Next Tab",     run: async () => { switchTab(1) } },
                  { name: "analyze.toggleRaw",  title: "Raw Prompt",   run: async () => {
                    const list = tabs()
                    const idx = Math.min(activeTab(), list.length - 1)
                    if (list[idx]?.id === "system") setShowRaw((s) => !s)
                  } },
                  { name: "analyze.copyRaw",    title: "Copy Raw Prompt", run: async () => { await copyRawSystemText() } },
                  { name: "analyze.reload",     title: "Reload",      run: async () => { reload() } },
                  { name: "analyze.expand1",    title: "Toggle Expand Message 1", run: () => { toggleExpand(0) } },
                  { name: "analyze.expand2",    title: "Toggle Expand Message 2", run: () => { toggleExpand(1) } },
                  { name: "analyze.expand3",    title: "Toggle Expand Message 3", run: () => { toggleExpand(2) } },
                  { name: "analyze.expand4",    title: "Toggle Expand Message 4", run: () => { toggleExpand(3) } },
                  { name: "analyze.expand5",    title: "Toggle Expand Message 5", run: () => { toggleExpand(4) } },
                ],
              })

              // Start async data fetch
              loadAnalysis()

              // Auto-poll: background refresh every minute so the dialog
              // stays in sync as the conversation grows. Uses backgroundReload
              // which doesn't nuke visible data or scroll position.
              pollInterval = setInterval(() => {
                backgroundReload()
              }, AUTO_POLL_MS)
            })

            onCleanup(() => {
              if (cleanupKeyLayer) {
                try { cleanupKeyLayer() } catch { /* ignore */ }
                cleanupKeyLayer = null
              }
              if (pollInterval) {
                clearInterval(pollInterval)
                pollInterval = null
              }
              if (copiedTimeout) {
                clearTimeout(copiedTimeout)
                copiedTimeout = null
              }
            })

            // ── Render helper ─────────────────────────────────────────────
            const safeFmt = (n: number) => (n > 0 ? fmt(n) : "0")

            return (
              <box paddingLeft={2} paddingRight={2} paddingBottom={1} flexDirection="column" gap={1}>
                {/* ── Title bar ────────────────────────────────────────── */}
                <box flexDirection="row" justifyContent="space-between">
                  <box flexDirection="row" gap={1}>
                    <text fg={fg}><b>Analyze</b></text>
                    <text fg={muted}>— Session {sidDisplay}</text>
                  </box>
                  <text fg={muted}>esc</text>
                </box>

                {/* ── Tab bar ────────────────────────────────────────── */}
                {(() => {
                  const list = tabs()
                  if (list.length <= 1) return <text fg={muted}> </text>
                  const idx = Math.min(activeTab(), list.length - 1)
                  return (
                    <box flexDirection="row" gap={1}>
                      {list.map((tab, i) => (
                        <box
                          key={tab.id}
                          paddingLeft={1}
                          paddingRight={1}
                          backgroundColor={i === idx ? primary : undefined}
                        >
                          <text fg={i === idx ? selectedText : muted}>{tab.label}</text>
                        </box>
                      ))}
                    </box>
                  )
                })()}

                {/* ── "more above" indicator ───────────────────────────── */}
                <text fg={muted}>{scroll.hasOverflow() && scroll.isScrolled() ? "▲ more above" : " "}</text>

                <scrollbox
                  ref={(el) => scroll.scrollRef = el}
                  flexDirection="column"
                  gap={1}
                  maxHeight={40}
                  scrollbarOptions={{ visible: false }}
                >
                  {loading() && categories().length === 0 ? (
                    <text fg={muted}>Loading session messages…</text>
                  ) : errorMsg() ? (
                    <box flexDirection="column" gap={1}>
                      <text fg={red}><b>Error Fetching Messages</b></text>
                      <text fg={muted}>{errorMsg()}</text>
                    </box>
                  ) : categories().length === 0 ? (
                    <text fg={muted}>No messages in this session.</text>
                  ) : (
                    (() => {
                      const list = tabs()
                      const idx = Math.min(activeTab(), list.length - 1)
                      const tab = list[idx]
                      if (!tab) return <text fg={muted}>No data.</text>

                      // ── Context tab: all categories + total ────────────
                      if (tab.id === "context") {
                        return (
                          <box paddingBottom={1}>
                            <text fg={fg}><b>Context Breakdown</b></text>
                            <text> </text>
                            <box flexDirection="column" gap={1}>
                              {categories().map((cat) => {
                                const total = estimatedTotal()
                                const pct = total > 0 ? (cat.totalTokens / total) * 100 : 0
                                const bar = buildBar(pct, BAR_WIDTH)
                                return (
                                  <box key={cat.name} flexDirection="column" gap={1}>
                                    <text fg={fg}><b>{cat.name}</b></text>
                                    <text fg={muted}>{pct.toFixed(1)}% — {safeFmt(cat.totalTokens)} tokens</text>
                                    <text fg={fg}>{bar}</text>
                                  </box>
                                )
                              })}
                            </box>
                            <text> </text>
                            <text fg={fg}>
                              Total: {safeFmt(estimatedTotal())} tokens ({safeFmt(messageCount())} msgs)
                            </text>
                          </box>
                        )
                      }

                      // ── Per-Tool tab ───────────────────────────────────
                      if (tab.id === "tools") {
                        const toolsCat = categories().find((c: Category) => c.name === "TOOLS")
                        if (!toolsCat || toolsCat.entries.length === 0) {
                          return <text fg={muted}>No tool data.</text>
                        }
                        const total = estimatedTotal()
                        return (
                          <box paddingBottom={1}>
                            <text fg={fg}><b>Per-Tool Breakdown</b></text>
                            <text> </text>
                            <box flexDirection="column" gap={1}>
                              {toolsCat.entries.map((entry: CategoryEntry) => {
                                const pct = total > 0 ? (entry.tokens / total) * 100 : 0
                                const bar = buildBar(pct, BAR_WIDTH)
                                return (
                                  <box key={entry.label} flexDirection="column" gap={1}>
                                    <text fg={fg}>{entry.label}</text>
                                    <text fg={muted}>{safeFmt(entry.tokens)} tokens</text>
                                    <text fg={fg}>{bar}</text>
                                  </box>
                                )
                              })}
                            </box>
                          </box>
                        )
                      }

                      // ── System tab ────────────────────────────────────
                      if (tab.id === "system") {
                        const sysCat = categories().find((c: Category) => c.name.startsWith("SYSTEM"))
                        if (!sysCat || sysCat.entries.length < 2) {
                          return <text fg={muted}>No system breakdown data.</text>
                        }
                        const sysTotal = sysCat.totalTokens

                        // Raw prompt visor (toggle with `v`): replaces the
                        // fragment list with the full assembled system text.
                        if (showRaw()) {
                          const raw = rawSystemText()
                          return (
                            <box paddingBottom={1}>
                              <text fg={fg}><b>Raw System Prompt</b> ({safeFmt(sysTotal)} tokens)</text>
                              <text> </text>
                              {raw
                                ? <text fg={fg}>{raw.length > 50000 ? raw.slice(0, 50000) + "\n\n… (truncated at 50000 chars)" : raw}</text>
                                : <text fg={muted}>No raw text stored for this session.</text>
                              }
                            </box>
                          )
                        }

                        const sorted = [...sysCat.entries].sort((a: CategoryEntry, b: CategoryEntry) => b.tokens - a.tokens)
                        return (
                          <box paddingBottom={1}>
                            <text fg={fg}><b>System Breakdown</b> ({safeFmt(sysTotal)} tokens)</text>
                            <text> </text>
                            <box flexDirection="column" gap={1}>
                              {sorted.map((entry: CategoryEntry, i: number) => {
                                const pct = sysTotal > 0 ? (entry.tokens / sysTotal) * 100 : 0
                                const bar = buildBar(pct, BAR_WIDTH)
                                return (
                                  <box key={entry.label + i} flexDirection="column" gap={1}>
                                    <text fg={fg}>{entry.label}</text>
                                    <text fg={muted}>{safeFmt(entry.tokens)} tokens ({pct.toFixed(1)}%)</text>
                                    <text fg={fg}>{bar}</text>
                                  </box>
                                )
                              })}
                            </box>
                          </box>
                        )
                      }

                      // ── Models tab ────────────────────────────────────
                      //
                      // Design note (self-verifiable row): ↑ = peakInputTokens,
                      // ↓ = outputTokens, and ↑ + ↓ feeds directly into the %
                      // formula. This mirrors the sidebar's peak-convention where
                      // peakInputTokens = input + cacheRead (per-call max). Every
                      // displayed number participates in the same computation.
                      if (tab.id === "models") {
                        const stats = modelStats()
                        if (stats.length === 0) {
                          return <text fg={muted}>No model usage data.</text>
                        }

                        const { sortedStats, totalModelTokens } = computeModelsTabLayout(stats)

                        return (
                          <box paddingBottom={1}>
                            <text fg={fg}><b>Models in Session</b></text>
                            <text> </text>
                            <box flexDirection="column" gap={1}>
                              {sortedStats.map((m, i) => {
                                const modelTokens = m.peakInputTokens + m.outputTokens
                                const pct = totalModelTokens > 0 ? (modelTokens / totalModelTokens) * 100 : 0
                                const hitRate = calcCacheHitRate(m.cacheRead, m.inputTokens)

                                const parts = [
                                  `↑ ${fmt(m.peakInputTokens)}`,
                                  `↓ ${fmt(m.outputTokens)}`
                                ]
                                if (hitRate !== null) {
                                  parts.push(`cache ${hitRate}% (${fmt(m.cacheRead)} read, ${fmt(m.cacheWrite)} write)`)
                                }
                                parts.push(`${pct.toFixed(1)}% tokens`)
                                if (m.cost > 0) {
                                  parts.push(fmtCost(m.cost))
                                }
                                const infoLine = parts.join("  ")

                                return (
                                  <box key={m.providerID + "/" + m.modelID} flexDirection="column" gap={1}>
                                    <text fg={fg}>{i + 1}. {m.providerID} / {m.modelID}  ·  {m.msgCount} msgs</text>
                                    <text fg={muted}>{infoLine}</text>
                                    <text fg={fg}>{buildBar(pct, 50)}</text>
                                  </box>
                                )
                              })}
                            </box>
                          </box>
                        )
                      }

                      // ── Extra Info tab ─────────────────────────────────
                      if (tab.id === "extra") {
                        const top = topContributors()
                        const cost = sessionCost()
                        const comp = compactionSummary()
                        const stats = modelStats()
                        const hotspots = hotspotResults()

                        return (
                          <box paddingBottom={1} flexDirection="column" gap={1}>
                            {/* a) Top Contributors */}
                            <box flexDirection="column" gap={0}>
                              <text fg={fg}><b>Top Contributors</b></text>
                              <text> </text>
                              {top.length === 0 ? (
                                <text fg={muted}>No contributor data.</text>
                              ) : (
                                <box flexDirection="column" gap={0}>
                                  {top.map((entry, i) => (
                                    <text key={entry.label + i} fg={fg}>
                                      {String(i + 1).padStart(2)}. {truncateLabel(entry.label)}{safeFmt(entry.tokens).padStart(10)} tokens
                                    </text>
                                  ))}
                                </box>
                              )}
                            </box>

                            {/* b) Session cost */}
                            {cost > 0 && (
                              <box flexDirection="column" gap={0}>
                                <text> </text>
                                <text fg={fg}><b>Session cost</b>: {fmtCost(cost)}</text>
                              </box>
                            )}

                            {/* c) Compactions */}
                            {(() => {
                              if (!comp || comp.count === 0) return null
                              const reductionText = comp.reductionTokens > 0 ? `, -${fmtCompact(comp.reductionTokens)} tokens` : ""
                              const pendingCount = comp.count - comp.measured
                              const pendingText = pendingCount > 0 && pendingCount < comp.count ? ` (${pendingCount} pending)` : ""
                              return (
                                <box flexDirection="column" gap={0}>
                                  <text> </text>
                                  <text fg={fg}>
                                    <b>Compactions</b>: {comp.count}{reductionText}{pendingText}
                                  </text>
                                </box>
                              )
                            })()}

                            {/* d) Model info */}
                            {(() => {
                              if (stats.length === 0) return null
                              if (stats.length === 1) {
                                return (
                                  <box flexDirection="column" gap={0}>
                                    <text> </text>
                                    <text fg={fg}><b>Model</b>: {stats[0].modelID}</text>
                                  </box>
                                )
                              }
                              const sortedStats = [...stats].sort((a, b) => b.msgCount - a.msgCount)
                              return (
                                <box flexDirection="column" gap={0}>
                                  <text> </text>
                                  <text fg={fg}><b>Model switches: {switchesCount()}</b></text>
                                  <text> </text>
                                  {sortedStats.map((st) => (
                                    <text key={st.providerID + "/" + st.modelID} fg={muted}>
                                      {"  "}{st.providerID} / {st.modelID}        {st.msgCount} msgs
                                    </text>
                                  ))}
                                </box>
                              )
                            })()}

                            {/* e) Unusually large messages */}
                            {hotspots.length > 0 && (
                              <box flexDirection="column" gap={0}>
                                <text> </text>
                                <text fg={fg}><b>Unusually large messages: {hotspots.length}</b></text>
                                <text> </text>
                                {hotspots.map((res, idx) => {
                                  const isExpanded = expandedHotspotIndex() === idx
                                  return (
                                    <box key={res.category + "/" + res.label + "/" + idx} flexDirection="column" gap={0} onMouseUp={() => toggleExpand(idx)}>
                                      <text fg={fg}>
                                        {"  "}{isExpanded ? "▾" : "▸"} {res.label}  {fmt(res.tokens)} tok  ({res.formattedRatio}x avg)
                                      </text>
                                      {!isExpanded && (
                                        <text fg={muted}>
                                          {"    "}{res.preview}
                                        </text>
                                      )}
                                      {isExpanded && (
                                        <box paddingLeft={4} paddingTop={1} paddingBottom={1} flexDirection="column">
                                          <box borderStyle="round" borderColor={muted} padding={1}>
                                            <text fg={fg}>{res.fullText}</text>
                                          </box>
                                        </box>
                                      )}
                                    </box>
                                  )
                                })}
                              </box>
                            )}
                          </box>
                        )
                      }

                      return <text fg={muted}>Unknown tab.</text>
                    })()
                  )}
                </scrollbox>

                {/* ── "more below" indicator ────────────────────────────── */}
                <text fg={muted}>{scroll.hasOverflow() && !scroll.isAtBottom() ? "▼ more below" : " "}</text>

                 {/* ── Footer hints ──────────────────────────────────────── */}
                {(() => {
                  const list = tabs()
                  const idx = Math.min(activeTab(), list.length - 1)
                  const currentTab = list[idx]
                  const isSys = currentTab?.id === "system"
                  const isExtra = currentTab?.id === "extra"
                  const hasHotspots = hotspotResults().length > 0

                  return (
                    <box flexDirection="row" gap={1}>
                      <text fg={muted}>← → tabs  ·  ↑↓ scroll</text>
                      {isSys && (
                        <>
                          <text fg={muted}>·  v raw</text>
                          {showRaw() && (
                            <>
                              <text fg={muted}>·</text>
                              {copiedFlash() ? (
                                <text fg={primary}>copied!</text>
                              ) : (
                                <text fg={muted}>c copy</text>
                              )}
                            </>
                          )}
                        </>
                      )}
                      {isExtra && hasHotspots && (
                        <text fg={muted}>·  1-5 expand</text>
                      )}
                      <text fg={muted}>·  r reload</text>
                    </box>
                  )
                })()}
              </box>
            )
          })
        },
      },
    ],
    bindings: [
      {
        key: "ctrl+shift+a",
        cmd: "analyze.show",
        desc: "Analyze Session Tokens",
      },
    ],
  })
}
