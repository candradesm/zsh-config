/** @jsxImportSource @opentui/solid */
import type { TuiPluginApi } from "@opencode-ai/plugin/tui"
import { onMount, onCleanup, createSignal, createMemo } from "solid-js"
import { existsSync, readFileSync } from "node:fs"
import { homedir } from "node:os"
import { log } from "./helpers/debug"
import { estimateTokens, rawPromptTokens, scaleEntries } from "./helpers/tokens"
import { buildBar, fmt } from "./helpers/format"
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
          const fg = theme?.foreground ?? "#ffffff"
          const muted = theme?.muted ?? "#888888"
          const red = theme?.red ?? "#ef4444"
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

          let pollInterval: any = null
          let cleanupKeyLayer: (() => void) | null = null
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
            if (topContributors().length > 0) t.push({ id: "top", label: "Top" })
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
                if (hasCompaction) sessionWasCompacted = true

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
                  userEntries.push({
                    label: `User #${userCounter}`,
                    tokens: estimateTokens(text),
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

                  const textParts = parts.filter((p: any) => p.type === "text")
                  const text = textParts.map((p: any) => p.text ?? "").join("")
                  if (text.trim().length > 0) {
                    assistantCounter++
                    log("analyze: COUNT assistant msg", msgId, "-", text.length, "chars ->", estimateTokens(text), "(char/4 est.) tokens (Assistant #" + assistantCounter + ")")
                    assistantEntries.push({
                      label: `Assistant #${assistantCounter}`,
                      tokens: estimateTokens(text),
                    })
                  }
                }

                // ── Tool parts ──────────────────────────────────────────────
                for (const part of parts) {
                  if (part.type === "tool" && part.state?.status === "completed") {
                    const output = part.state?.output ?? ""
                    if (output.length > 0) {
                      const toolName = part.tool ?? "unknown"
                      toolMap.set(
                        toolName,
                        (toolMap.get(toolName) ?? 0) + estimateTokens(output),
                      )
                    }
                  }
                  // Also count tool call arguments (the JSON the model sends to invoke the tool)
                  if (part.type === "tool") {
                    const callInput = part.state?.input ?? part.arguments ?? part.call?.arguments
                    if (callInput) {
                      const inputText = typeof callInput === "string" ? callInput : JSON.stringify(callInput)
                      if (inputText.length > 0) {
                        const toolName = part.tool ?? "unknown"
                        toolMap.set(
                          toolName,
                          (toolMap.get(toolName) ?? 0) + estimateTokens(inputText),
                        )
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
              const serverFrags: SystemFragment[] = serverSnapshot?.fragments ?? []

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
                  { key: "r",    cmd: "analyze.reload",     desc: "Reload" },
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
                  { name: "analyze.reload",     title: "Reload",      run: async () => { reload() } },
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

                      // ── Top Contributors tab ──────────────────────────
                      if (tab.id === "top") {
                        const top = topContributors()
                        if (top.length === 0) return <text fg={muted}>No contributor data.</text>
                        return (
                          <box paddingBottom={1}>
                            <text fg={fg}><b>Top Contributors</b></text>
                            <text> </text>
                            <box flexDirection="column" gap={0}>
                              {top.map((entry, i) => (
                                <text key={entry.label + i} fg={fg}>
                                  {String(i + 1).padStart(2)}. {entry.label.padEnd(24)}{safeFmt(entry.tokens).padStart(10)} tokens
                                </text>
                              ))}
                            </box>
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
                  const isSys = list[idx]?.id === "system"
                  return (
                    <text fg={muted}>
                      ← → tabs  ·  ↑↓ scroll{isSys ? "  ·  v raw" : ""}  ·  r reload  ·  auto ↻60s
                    </text>
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
