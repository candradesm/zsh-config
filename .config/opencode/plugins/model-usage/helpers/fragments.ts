import type { SystemFragment } from "../types"
import { estimateTokens } from "./tokens"

/**
 * Split an assembled system prompt into labelled fragments by
 * jungle-mode `Instructions from:` markers, and XML-like section blocks
 * (`<available_references>`, `<mcp_instructions>`, `<available_skills>`).
 * Each fragment's tokens are estimated with char/4. Pure / testable.
 */
export function splitSystemFragments(systemText: string, maxFragments = 100): SystemFragment[] {
  if (!systemText || systemText.trim().length === 0) return []
  const lines = systemText.split("\n")
  const buckets: { label: string; text: string }[] = []
  let current: { label: string; text: string } | null = null
  let xmlMode = false
  let xmlCloseTag = ""
  let pluginMode = false
  let pluginBlankCount = 0

  let hasCreatedAnyBucket = false
  let afterJungleMode = false

  // Top-level XML sections in the assembled system prompt (system.ts,
  // skill.ts). Only these three tags start a new fragment; inner tags
  // like <example>, <server>, <reference>, <skill> are content.
  const sectionOpen = /^<(available_references|mcp_instructions|available_skills)>/
  const friendlyLabel: Record<string, string> = {
    available_references: "References",
    mcp_instructions: "MCP Instructions",
    available_skills: "Skills",
  }

  const push = () => {
    if (current && current.text.trim().length > 0) {
      buckets.push(current)
    }
    current = null
  }

  for (const line of lines) {
    // Inside a multi-line XML block: collect until the closing tag.
    if (xmlMode) {
      current!.text += line + "\n"
      if (line.includes(xmlCloseTag)) {
        push()
        xmlMode = false
      }
      continue
    }

    // Inside a plugin-injected section (e.g. jungle-mode persona):
    // collect everything until two consecutive blank lines — the
    // boundary between the plugin section and the original system prompt.
    // Headers within this section (like `## 🍌 JUNGLE MODE ACTIVE 🍌`)
    // are content, not separate fragments.
    if (pluginMode) {
      current!.text += line + "\n"
      if (line.trim().length === 0) {
        pluginBlankCount++
        if (pluginBlankCount >= 2) {
          push()
          pluginMode = false
          afterJungleMode = true
        }
      } else {
        pluginBlankCount = 0
      }
      continue
    }

    // XML block start (section-level only).
    const xmlMatch = sectionOpen.exec(line)
    if (xmlMatch) {
      const tag = xmlMatch[1]
      push()
      current = { label: friendlyLabel[tag] ?? tag.replace(/_/g, " "), text: line + "\n" }
      hasCreatedAnyBucket = true
      afterJungleMode = false
      xmlCloseTag = `</${tag}>`
      if (line.includes(xmlCloseTag)) {
        push()
      } else {
        xmlMode = true
      }
      continue
    }

    const jungle = /^Instructions from:\s*(.+)$/.exec(line)
    if (jungle) {
      push()
      const rawLabel = jungle[1].trim()
      const label = rawLabel.length > 48 ? rawLabel.slice(0, 47) + "…" : rawLabel
      current = { label, text: line + "\n" }
      hasCreatedAnyBucket = true
      afterJungleMode = false
      // Only enter plugin mode for jungle-mode injections (collect until
      // double blank line). Other Instructions from: lines (e.g. AGENTS.md
      // file references) are regular section headers — don't swallow their
      // content into plugin mode.
      if (/^jungle-mode\//.test(jungle[1].trim())) {
        pluginMode = true
        pluginBlankCount = 0
      }
    } else if (current) {
      current.text += line + "\n"
    } else {
      // current is null. This is a marker-less line.
      let label = ""
      if (!hasCreatedAnyBucket) {
        label = "Agent System Prompt"
        hasCreatedAnyBucket = true
      } else if (afterJungleMode) {
        label = "Agent System Prompt"
        afterJungleMode = false
      } else {
        label = "other_markerless"
      }
      current = { label, text: line + "\n" }
    }
  }
  push()

  const frags: SystemFragment[] = []
  let otherMarkerlessTokens = 0

  for (const b of buckets) {
    const tokens = estimateTokens(b.text)
    if (tokens <= 0) continue

    if (b.label === "other_markerless") {
      otherMarkerlessTokens += tokens
    } else {
      frags.push({
        label: b.label || "section",
        tokens,
      })
    }
  }

  if (otherMarkerlessTokens > 0) {
    frags.push({
      label: "Other",
      tokens: otherMarkerlessTokens,
    })
  }

  if (frags.length <= maxFragments) return frags.sort((a, b) => b.tokens - a.tokens)

  const sorted = frags.sort((a, b) => b.tokens - a.tokens)
  const kept = sorted.slice(0, maxFragments)
  const otherTotal = sorted.slice(maxFragments).reduce((s, f) => s + f.tokens, 0)
  if (otherTotal > 0) kept.push({ label: "… more", tokens: otherTotal })
  return kept
}
