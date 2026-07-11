import { existsSync, readFileSync } from "node:fs"
import { homedir } from "node:os"
import { log } from "./helpers/debug"
import { estimateTokens, rawPromptTokens, scaleEntries, estimateVisibleOutputTokens } from "./helpers/tokens"
import { PREVIEW_MAX_LEN } from "./helpers/format"
import { resolveCompactionEvents } from "./helpers/compaction"
import type { CompactionSummary } from "./helpers/compaction"
import { detectHotspots, pickPreview, summarizeToolInput, shortenPath } from "./helpers/hotspots"
import { countModelSwitches } from "./helpers/model-tab"
import type { HotspotCandidate, HotspotResult } from "./helpers/hotspots"
import { aggregateModelStats } from "./helpers/models"
import type { ModelUsageRecord, ModelStat } from "./helpers/models"
import { splitSystemFragments } from "./helpers/fragments"
import { loadBaseline } from "./db"
import type { SystemFragment, SystemSnapshot, SystemSource, ToolDefSnapshot } from "./types"
import type { Message, Part } from "@opencode-ai/sdk/v2"

export interface CategoryEntry {
  label: string
  tokens: number
}

export interface Category {
  name: string
  entries: CategoryEntry[]
  totalTokens: number
}

export interface FormattedHotspotResult extends HotspotResult {
  formattedRatio: string
}

export interface AnalysisData {
  categories: Category[]
  estimatedTotal: number
  topContributors: CategoryEntry[]
  hasToolsSection: boolean
  messageCount: number
  modelStats: ModelStat[]
  switchesCount: number
  compactionSummary: CompactionSummary | null
  sessionCost: number
  hotspotResults: FormattedHotspotResult[]
  rawSystemText: string
  rawToolDefsText: string
  toolDefsTokens: number
  syntheticTokens: number
}

// ── Tier 3: system snapshot from server plugin ──────────────────────────────
// Reads the LATEST measurement persisted by model-usage-server.ts.
// Returns {total (char/4), fragments, ts} or null when the server
// plugin has never fired for this session (e.g. cold start, V2-only).
export function loadSystemSnapshot(sessionID: string): SystemSnapshot | null {
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

// ── Tool definitions snapshot from server plugin ────────────────────────────
// Reads the LATEST tool definitions persisted by model-usage-server.ts
// via the "tool.definition" hook to tool-defs.json.
export function loadToolDefsSnapshot(sessionID: string): ToolDefSnapshot | null {
  const file = `${homedir()}/.config/opencode/plugins/model-usage/tool-defs.json`
  log("loadToolDefsSnapshot: checking for session", sessionID)
  try {
    if (!existsSync(file)) {
      log("loadToolDefsSnapshot: tool-defs.json not found")
      return null
    }
    const raw = readFileSync(file, "utf-8")
    const data = JSON.parse(raw) as Record<string, ToolDefSnapshot>
    log("loadToolDefsSnapshot: loaded", Object.keys(data).length, "sessions, checking for", sessionID)
    const entry = data[sessionID]
    if (entry && typeof entry.t === "number" && entry.fragments && entry.fragments.length > 0) {
      log("loadToolDefsSnapshot: FOUND entry for", sessionID, "t =", entry.t, "fragments =", entry.fragments.length)
      return entry
    }
    log("loadToolDefsSnapshot: no entry for session", sessionID, "(found", Object.keys(data).length, "other sessions)")
  } catch { /* ignore */ }
  return null
}

// ── Tier 1: V2 baseline DB ──────────────────────────────────────────────────
// The V2 native runner persists the full assembled system prompt to
// `session_context_epoch.baseline` on every turn. This is the exact
// text — we tokenise with char/4. Returns null on V1 (table empty)
// or older builds (table absent).
export function loadBaselineTokens(sessionID: string): number | null {
  const dbPath = `${homedir()}/.local/share/opencode/opencode.db`
  if (!existsSync(dbPath)) return null
  const baseline = loadBaseline(dbPath, sessionID)
  if (!baseline) return null
  const t = estimateTokens(baseline)
  log("loadBaselineTokens: hit, baseline chars =", baseline.length, "→ tokens", t)
  return t
}

// ── Main domain analysis ────────────────────────────────────────────────────
// PURE function: takes immutable inputs, returns AnalysisData.
// Does NOT set any SolidJS signals or access the TUI plugin API.
export function analyzeSessionMessages(
  messages: Array<{ id?: string; info: Message; parts: Part[] }>,
  currentSessionID: string,
  serverSnapshot: SystemSnapshot | null,
  baselineTokens: number | null,
): AnalysisData {
  log("=== analyze: loaded", messages.length, "messages for session", currentSessionID, "===")

  if (messages.length === 0) {
    return {
      categories: [],
      estimatedTotal: 0,
      topContributors: [],
      hasToolsSection: false,
      messageCount: 0,
      modelStats: [],
      switchesCount: 0,
      compactionSummary: null,
      sessionCost: 0,
      hotspotResults: [],
      rawSystemText: serverSnapshot?.rawText ?? "",
      rawToolDefsText: "",
      toolDefsTokens: 0,
      syntheticTokens: 0,
    }
  }

  // ── Process messages ──────────────────────────────────────────────────────
  const userEntries: CategoryEntry[] = []
  const assistantEntries: CategoryEntry[] = []
  const toolMap = new Map<string, number>()
  const reasoningEntries: CategoryEntry[] = []
  let userCounter = 0
  let assistantCounter = 0
  let reasoningCounter = 0
  let syntheticTokensBeforeFirstAssistant: number = 0
  const syntheticEntries: CategoryEntry[] = []

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
  const rawSystemText = serverSnapshot?.rawText ?? ""
  const toolDefsSnapshot = loadToolDefsSnapshot(currentSessionID)
  log("analyze: toolDefsSnapshot =", toolDefsSnapshot ? `t=${toolDefsSnapshot.t} frags=${toolDefsSnapshot.fragments.length}` : "null")
  const rawToolDefsText = toolDefsSnapshot?.rawText ?? ""
  const toolDefsFragments: SystemFragment[] = toolDefsSnapshot?.fragments ?? []

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
      const asstInfo = info as unknown as { providerID?: string; modelID?: string; tokens?: { input?: number; output?: number; cache?: { read?: number; write?: number }; reasoning?: number }; cost?: number }
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
          `[ledger diagnostic] msgId: ${msgId} | providerID/modelID: ${providerID}/${modelID} | rawTokens: ${JSON.stringify(asstInfo.tokens ?? {})} | cost: ${asstInfo.cost ?? 0} | currentRawPrompt: ${currentRawPrompt} | hasTelemetry: ${hasTelemetry} | action: ${hasTelemetry ? "pushed" : "skipped"} | partsBreakdown: ${JSON.stringify(partCounts)} | hasNonEmptyTextPart: ${hasNonEmptyTextPart} | visibleOutputTokens: ${visibleOutputTokens}`,
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

    // ── User messages ───────────────────────────────────────────────────────
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
      // Count synthetic text parts separately
      for (const part of parts) {
        if (part.type === "text" && part.synthetic === true) {
          const synText = part.text ?? ""
          if (synText.trim().length > 0) {
            const synTokens = estimateTokens(synText)
            syntheticEntries.push({
              label: `Synthetic: ${makePreview(synText)}`,
              tokens: synTokens,
            })
          }
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

    // ── Assistant messages ──────────────────────────────────────────────────
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
        syntheticTokensBeforeFirstAssistant = syntheticEntries.reduce((s, e) => s + e.tokens, 0)
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

    // ── Tool parts ──────────────────────────────────────────────────────────
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
      log("analyze: msg", msgId, "tool output total:", Array.from(toolMap.values()).reduce((a, b) => a + b, 0), "estimated tokens across", toolMap.size, "tools")
    }

    // ── Reasoning parts ─────────────────────────────────────────────────────
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

  // ── Resolve compaction events ─────────────────────────────────────────────
  // Pure function extracts compaction events from the raw message
  // stream, resolving before/after tokens from adjacent assistant
  // rawPromptTokens. Multi-consecutive-compaction limitation doc:
  // if two compactions happen with no assistant between them, the
  // second compaction's `before` reuses the first's prior assistant
  // value (stale). This is rare and acceptable.
  let compactionSummary: CompactionSummary | null = null
  const { events: resolvedCompactionEvents, summary: resolvedCompactionSummary } = resolveCompactionEvents(messages)
  if (resolvedCompactionEvents.length > 0) {
    sessionWasCompacted = true
    compactionSummary = resolvedCompactionSummary
    log("analyze: compaction summary:", JSON.stringify(resolvedCompactionSummary))
  }

  // ── Build categories ──────────────────────────────────────────────────────
  const cats: Category[] = []

  // ── SYSTEM token resolution (cross-validated, tiered) ────────────────────
  // Cross-validated tier resolution: server snapshot (system-only) is the
  // most accurate source. Tier 2 telemetry provides the raw prompt size
  // which we use as a validation check and to compute tool defs residual.
  const serverTotal = serverSnapshot?.t ?? null
  // Re-split from rawText with the current splitSystemFragments logic.
  // This makes fragment display immune to stale server-cached fragments
  // (the server plugin may not re-capture on every restart if the system prompt
  // hasn't changed materially, leaving old pre-PR#39 fragments in system-tokens.json).
  const rawSysText = serverSnapshot?.rawText
  const serverFrags: SystemFragment[] = rawSysText
    ? splitSystemFragments(rawSysText)
    : (serverSnapshot?.fragments ?? [])

  let tier2SystemWithTools: number | null = null
  let systemTokens: number = 0
  let systemSource: SystemSource | null = null
  let toolDefsTokens: number = 0

  // Always compute Tier 2 raw when telemetry is available (no clean gate)
  if (firstNonzeroAssistant !== null && !sessionWasCompacted) {
    const info = firstNonzeroAssistant?.info as any
    const raw = rawPromptTokens(info?.tokens ?? {})
    const conversationBefore = conversationTokensBeforeFirstAssistant ?? 0
    tier2SystemWithTools = Math.max(0, raw - conversationBefore)
    log("analyze: SYSTEM Tier 2 computed: raw =", raw, "conversationBefore =", conversationBefore, "→ tier2SystemWithTools =", tier2SystemWithTools)
  }

  // Cross-validate: server snapshot is the most accurate for system-only
  if (serverTotal !== null) {
    systemTokens = serverTotal
    systemSource = "server"
    log("analyze: SYSTEM using server snapshot =", systemTokens)
    // Compute tool defs residual: telemetry total minus everything we account for
    if (tier2SystemWithTools !== null && tier2SystemWithTools > systemTokens) {
      const synthBefore = syntheticTokensBeforeFirstAssistant ?? 0
      toolDefsTokens = Math.max(0, tier2SystemWithTools - systemTokens - synthBefore)
      log("analyze: TOOL DEFS residual:", toolDefsTokens, "(tier2 =", tier2SystemWithTools, "system =", systemTokens, "synth =", synthBefore, ")")
    }
  } else if (tier2SystemWithTools !== null) {
    systemTokens = tier2SystemWithTools
    systemSource = "telemetry (est.)"
    log("analyze: SYSTEM no server snapshot, using telemetry (est.) =", systemTokens, "(includes tool defs)")
  } else {
    log("analyze: SYSTEM no tier available (0)")
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
    if (serverFrags.length > 0) {
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

  if (toolDefsTokens > 0 || toolDefsFragments.length > 0) {
    // Use actual per-tool fragments from the server plugin when available,
    // falling back to the residual total as a single entry.
    let tdEntries: CategoryEntry[]
    let tdTotal: number
    if (toolDefsFragments.length > 0 && toolDefsTokens > 0) {
      // Scale server-captured fragments to match the telemetry-derived residual
      tdEntries = scaleEntries(toolDefsFragments, toolDefsTokens).map((f) => ({
        label: f.label,
        tokens: f.tokens,
      }))
      tdTotal = toolDefsTokens
    } else if (toolDefsFragments.length > 0) {
      tdEntries = toolDefsFragments.map((f) => ({ label: f.label, tokens: f.tokens }))
      tdTotal = toolDefsFragments.reduce((s, f) => s + f.tokens, 0)
    } else {
      tdEntries = [{ label: "Tool schemas & overhead", tokens: toolDefsTokens }]
      tdTotal = toolDefsTokens
    }
    cats.push({
      name: "TOOL DEFS",
      entries: tdEntries,
      totalTokens: tdTotal,
    })
  }

  if (syntheticEntries.length > 0) {
    const syntheticTotal = syntheticEntries.reduce((s, e) => s + e.tokens, 0)
    cats.push({
      name: "SYNTHETICS",
      entries: syntheticEntries,
      totalTokens: syntheticTotal,
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
  log("=== analyze: category summary ===")
  log("  telemetry: reasoning =", reasoningTelemetry)
  for (const cat of cats) {
    log("  ", cat.name, ":", cat.entries.length, "entries,", cat.totalTokens, "estimated tokens")
  }
  log("  TOTAL estimated:", cats.reduce((s, c) => s + c.totalTokens, 0))

  // ── Top contributors (all entries, sorted, top 10) ────────────────────────
  const allEntries = cats.flatMap((c) => c.entries)
  const top10 = allEntries
    .filter((e) => e.tokens > 0)
    .sort((a, b) => b.tokens - a.tokens)
    .slice(0, 10)

  // ── Aggregate model stats ─────────────────────────────────────────
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
    lastCallRawPromptTokens: s.lastCallRawPromptTokens,
  }))))

  // ── Compute sequential model switches ──
  const switchesCount = countModelSwitches(messages)

  // ── Compute session cost ──
  const totalCost = modelUsageRecords.reduce((acc, r) => acc + r.cost, 0)

  // ── Detect hotspots ──
  // Scoped to USER and TOOLS categories only (not ASSISTANT, not SYSTEM, not REASONING - intentional per issue spec)
  const candidates: Record<string, HotspotCandidate[]> = {
    USER: userCandidates,
    TOOLS: toolsCandidates,
  }
  const results = detectHotspots(candidates)
  const hotspotResults = results.map((res) => ({
    ...res,
    formattedRatio: res.ratio.toFixed(1),
  }))

  return {
    categories: cats,
    estimatedTotal: totalEstimated,
    topContributors: top10,
    hasToolsSection: toolEntries.length > 0,
    messageCount: messages.length,
    modelStats: stats,
    switchesCount,
    compactionSummary,
    sessionCost: totalCost,
    hotspotResults: hotspotResults,
    rawSystemText,
    rawToolDefsText,
    toolDefsTokens,
    syntheticTokens: syntheticEntries.reduce((s, e) => s + e.tokens, 0),
  }
}
