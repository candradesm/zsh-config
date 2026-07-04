/** @jsxImportSource @opentui/solid */
import type { TuiPluginApi } from "@opencode-ai/plugin/tui"

export function registerExampleCommand(api: TuiPluginApi) {
  api.keymap.registerLayer({
    commands: [
      {
        name: "example.show",
        title: "Example Dialog",
        category: "Plugin",
        namespace: "palette",
        slashName: "example",
        async run() {
          // dialog logic here
        },
      },
    ],
    bindings: [
      {
        key: "ctrl+shift+e",
        cmd: "example.show",
        desc: "Open Example Dialog",
      },
    ],
  })
}
