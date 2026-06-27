import { homedir } from "node:os"
import { getPersonaForAgent } from "./jungle-mode/persona"

const CONFIG_PATH = `${homedir()}/.config/opencode/jungle-mode.json`
const injectedSessions = new Set<string>()

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
    // Coordinator: hidden system prompt injection
    "experimental.chat.system.transform": async (
      _input: { sessionID?: string; model: any },
      output: { system: string[] },
    ) => {
      const enabled = await isJungleEnabled()
      if (!enabled) return

      if (!detectCoordinatorInSystem(output.system)) return
      if (_input.sessionID && injectedSessions.has(_input.sessionID)) return

      const persona = getPersonaForAgent("coordinator")
      if (!persona) return

      if (_input.sessionID) injectedSessions.add(_input.sessionID)
      output.system.push(persona)
    },

    // Subagents: edit existing text part
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

      if (injectedSessions.has(input.sessionID)) return

      const agent = input.agent?.toLowerCase()
      if (!agent || agent === "coordinator") return

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
