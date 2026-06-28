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

function detectCoordinatorInSystem(system: string[]): boolean {
  return system.join("\n").includes("Lead Coordinator Agent")
}

export const JungleModePlugin = async () => {
  return {
    "experimental.chat.system.transform": async (
      _input: { sessionID?: string; model: any },
      output: { system: string[] },
    ) => {
      const enabled = await isJungleEnabled()
      if (!enabled) return

      // Primary path: Map bridge (plan/build/coordinator)
      const agent = _input.sessionID ? sessionAgent.get(_input.sessionID) : undefined
      if (agent) {
        // Skip title generator — it fires first and would steal the persona from the real agent
        if (output.system.join("\n").includes("You are a title generator")) return
        sessionAgent.delete(_input.sessionID)
        if (injectedSessions.has(_input.sessionID + ":" + agent)) return
        const persona = getPersonaForAgent(agent)
        if (persona) {
          injectedSessions.add(_input.sessionID + ":" + agent)
          output.system[0] = "Instructions from: jungle-mode/primary-agent-persona\n" + persona + "\n\n" + output.system[0]
        }
        return
      }

      // Fallback: original string matching for coordinator
      if (!detectCoordinatorInSystem(output.system)) return
      if (_input.sessionID && injectedSessions.has(_input.sessionID)) return

      const persona = getPersonaForAgent("coordinator")
      if (!persona) return

      if (_input.sessionID) injectedSessions.add(_input.sessionID)
      output.system[0] = "Instructions from: jungle-mode/primary-agent-persona\n" + persona + "\n\n" + output.system[0]
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
