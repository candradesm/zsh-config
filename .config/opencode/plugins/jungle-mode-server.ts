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

function detectPersonaFromSystem(system: string[]): string | null {
  const text = system.join("\n")
  if (text.includes("Lead Coordinator Agent")) return getPersonaForAgent("coordinator")
  if (text.includes("Implementation Agent")) return getPersonaForAgent("developer")
  if (text.includes("Test Agent")) return getPersonaForAgent("testing")
  if (text.includes("Quality Agent")) return getPersonaForAgent("qa")
  if (text.includes("Review Agent")) return getPersonaForAgent("reviewer")
  return null
}

export const JungleModePlugin = async () => {
  return {
    "experimental.chat.system.transform": async (
      input: { sessionID?: string; model: any },
      output: { system: string[] },
    ) => {
      const enabled = await isJungleEnabled()
      if (!enabled) return

      // Only inject once per session
      if (input.sessionID && injectedSessions.has(input.sessionID)) return

      const persona = detectPersonaFromSystem(output.system)
      if (!persona) return

      if (input.sessionID) injectedSessions.add(input.sessionID)
      output.system.push(persona)
    },
  }
}
