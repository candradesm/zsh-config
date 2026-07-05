import type { SystemFragment } from "../types"
import { estimateTokens } from "./tokens"

/**
 * Split an assembled system prompt into labelled fragments by markdown header,
 * jungle-mode `Instructions from:` markers, and XML-like section blocks
 * (`<available_references>`, `<mcp_instructions>`, `<available_skills>`).
 * Each fragment's tokens are estimated with char/4.  Pure / testable.
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
    if (current && current.text.trim().length > 0) buckets.push(current)
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
      xmlCloseTag = `</${tag}>`
      if (line.includes(xmlCloseTag)) {
        push()
      } else {
        xmlMode = true
      }
      continue
    }

    const header = /^(#{1,3})\s+(.+)$/.exec(line)
    const jungle = /^Instructions from:\s*(.+)$/.exec(line)
    if (header) {
      push()
      current = { label: header[2].trim().slice(0, 48), text: line + "\n" }
    } else if (jungle) {
      push()
      current = { label: jungle[1].trim().slice(0, 48), text: line + "\n" }
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
      // Preamble before any header — bucket as "preamble".
      current = { label: "preamble", text: line + "\n" }
    }
  }
  push()

  const frags: SystemFragment[] = buckets.map((b) => ({
    label: b.label || "section",
    tokens: estimateTokens(b.text),
  }))

  if (frags.length <= maxFragments) return frags.sort((a, b) => b.tokens - a.tokens)

  const sorted = frags.sort((a, b) => b.tokens - a.tokens)
  const kept = sorted.slice(0, maxFragments)
  const otherTotal = sorted.slice(maxFragments).reduce((s, f) => s + f.tokens, 0)
  if (otherTotal > 0) kept.push({ label: "other", tokens: otherTotal })
  return kept
}
