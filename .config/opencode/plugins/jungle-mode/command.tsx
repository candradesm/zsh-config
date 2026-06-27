/** @jsxImportSource @opentui/solid */
import type { TuiPluginApi } from "@opencode-ai/plugin/tui"
import { homedir } from "node:os"
import type { Accessor, Setter } from "solid-js"

const CONFIG_PATH = `${homedir()}/.config/opencode/jungle-mode.json`

export async function readJungleMode(): Promise<boolean> {
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

async function writeJungleMode(enabled: boolean): Promise<void> {
  await Bun.write(CONFIG_PATH, JSON.stringify({ enabled }))
}

export function registerJungleCommand(
  api: TuiPluginApi,
  enabled: Accessor<boolean>,
  setEnabled: Setter<boolean>,
) {
  api.keymap.registerLayer({
    commands: [
      {
        name: "jungle.toggle",
        title: "Toggle Jungle Mode",
        category: "Plugin",
        namespace: "palette",
        slashName: "jungle",
        keybind: "ctrl+j",
        async run() {
          const newState = !enabled()
          await writeJungleMode(newState)
          setEnabled(newState)
        },
      },
    ],
  })
}
