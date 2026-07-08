/** @jsxImportSource @opentui/solid */
import type { TuiPluginApi } from "@opencode-ai/plugin/tui"
import { onMount, onCleanup, createSignal, createMemo } from "solid-js"
import { log } from "./helpers/debug"
import { buildBar, fmt, truncateLabel, fmtCompact, fmtCost } from "./helpers/format"
import { writeClipboard } from "./helpers/clipboard"
import type { CompactionSummary } from "./helpers/compaction"
import { computeModelsTabLayout } from "./helpers/model-tab"
import type { ModelStat } from "./helpers/models"
import { calcCacheHitRate } from "./helpers/cost"
import { makeScrollState } from "./shared/scroll"
import { registerDialogKeyLayer } from "./shared/keys"
import { createLoadGuard } from "./shared/reload"
import type { SessionMessagesResponse } from "@opencode-ai/sdk/v2"
import { loadSystemSnapshot, loadBaselineTokens, analyzeSessionMessages, type AnalysisData, type CategoryEntry, type Category, type FormattedHotspotResult } from "./analyze-domain"

interface ThemeColors {
  foreground?: string
  muted?: string
  red?: string
  primary?: string
  selectedListItemText?: string
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
            if (key === "pageup")   { scroll.handlePageUp(); return true }
            if (key === "pagedown") { scroll.handlePageDown(); return true }
            return false
          }

          // ── Data loader ───────────────────────────────────────────────────
          async function loadAnalysis() {
            const gen = loadGuard.invalidate()
            try {
              const result = await api.client.session.messages({
                sessionID: currentSessionID,
                limit: 10000,
              })
              if (!loadGuard.isCurrent(gen)) { log("analyze: stale fetch, discarding"); return }
              const apiResult = result as SessionMessagesResponse
              const messages = Array.isArray(apiResult.data) ? apiResult.data as any[] : []
              setMessageCount(messages.length)
              log("=== analyze: loaded", messages.length, "messages for session", currentSessionID, "===")

              if (messages.length === 0) {
                setLoading(false)
                return
              }

              const serverSnapshot = loadSystemSnapshot(currentSessionID)
              const baselineTokens = loadBaselineTokens(currentSessionID)

              const data = analyzeSessionMessages(messages, currentSessionID, serverSnapshot, baselineTokens)

              setRawSystemText(data.rawSystemText)
              setCategories(data.categories)
              setEstimatedTotal(data.estimatedTotal)
              setTopContributors(data.topContributors)
              setHasToolsSection(data.hasToolsSection)
              setModelStats(data.modelStats)
              setSwitchesCount(data.switchesCount)
              setCompactionSummary(data.compactionSummary)
              setSessionCost(data.sessionCost)
              setHotspotResults(data.hotspotResults)

              setLoading(false)
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
                  { key: "pageup",   cmd: "analyze.pageUp",   desc: "Page up" },
                  { key: "pagedown", cmd: "analyze.pageDown", desc: "Page down" },
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
                  { name: "analyze.pageUp",   title: "Page Up",   run: async () => { handleKey("pageup") } },
                  { name: "analyze.pageDown", title: "Page Down", run: async () => { handleKey("pagedown") } },
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
                      <text fg={muted}>← → tabs  ·  PgUp/Dn ↑↓ scroll</text>
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
