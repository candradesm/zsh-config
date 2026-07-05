import { homedir } from "node:os"
import { getPersonaForAgent } from "./jungle-mode/persona"

const CONFIG_PATH = `${homedir()}/.config/opencode/jungle-mode.json`
const injectedSessions = new Set<string>()
const sessionAgent = new Map<string, string>()

async function isJungleEnabled(): Promise<boolean> {
  try {
    const file = Bun.file(CONFIG_PATH)
    const exists = await file.exists()
    if (!exists) return false
    const text = await file.text()
    const config = JSON.parse(text)
    return config.enabled === true
  } catch {
    return false
  }
}

/**
 * Detect the primary agent name from the assembled system content.
 * Reliable even when `chat.message` fires after `system.transform`
 * (hook-ordering race on the first call of a session).
 *
 * - Coordinator: the system contains "Lead Coordinator Agent"
 * - Plan/Build:   the system starts with "You are opencode" (the standard
 *                 OpenCode preamble) but has NO "Lead Coordinator Agent"
 * - Subagents:    none of the above — return undefined so we don't inject
 *                 a primary-agent persona into subagent calls
 */
function detectPrimaryAgent(system: string[]): string | undefined {
  const text = system.join("\n")
  if (text.includes("Lead Coordinator Agent")) return "coordinator"
  if (text.startsWith("You are opencode, an interactive CLI tool")) return "plan"
  return undefined
}

export const JungleModePlugin = async () => {
  return {
    "experimental.chat.system.transform": async (
      _input: { sessionID?: string; model: any },
      output: { system: string[] },
    ) => {
      const enabled = await isJungleEnabled()
      if (!enabled) return

      // Skip title generator — it fires first and would steal the persona from the real agent
      if (output.system.join("\n").includes("You are a title generator")) return

      // Per-call guard: if the persona is already in the system array, this
      // hook fired twice on the same call (or another plugin re-injected).
      // Bail to avoid duplication. The system array is FRESH on every API
      // call, so we DO want to inject on every call — the persona must be
      // persistent, not one-time.
      const JUNGLE_MARKER = "Instructions from: jungle-mode/primary-agent-persona"
      if (output.system.join("\n").includes(JUNGLE_MARKER)) return

      // Reliable agent detection, ordered by priority:
      // 1. sessionAgent bridge — set by `chat.message` hook (most accurate).
      //    We do NOT delete after use — it persists so subsequent
      //    `system.transform` calls for the same session always find the
      //    agent even when `chat.message` doesn't re-fire.
      // 2. System content — detects coordinator vs plan/build from the
      //    assembled system text.  Works on the very first call before
      //    `chat.message` runs (hook-ordering race).
      let agent = _input.sessionID ? sessionAgent.get(_input.sessionID) : undefined
      if (!agent) {
        agent = detectPrimaryAgent(output.system)
      }

      const persona = getPersonaForAgent(agent)
      if (persona) {
        output.system[0] = JUNGLE_MARKER + "\n" + persona + "\n\n" + output.system[0]
      }
    },

    "chat.message": async (
      input: {
        sessionID: string
        agent?: string
        model?: { providerID: string; modelID: string }
        messageID?: string
        variant?: string
      },
      output: { message: any; parts: any[] },
    ) => {
      const enabled = await isJungleEnabled()
      if (!enabled) return

      // Detect agent from resolved message (always populated)
      const agent = output.message?.agent?.toLowerCase()
      if (!agent) return

      // Primary agents: store for system.transform, skip message injection
      if (agent === "coordinator" || agent === "plan" || agent === "build") {
        sessionAgent.set(input.sessionID, agent)
        return
      }

      // Subagents: prepend persona to message text
      if (injectedSessions.has(input.sessionID)) return

      const persona = getPersonaForAgent(agent)
      if (!persona) return

      injectedSessions.add(input.sessionID)

      const part = output.parts.find((p: any) => p.type === "text" && !p.synthetic)
      if (part) {
        part.text = persona + part.text
      }
    },
  }
}
