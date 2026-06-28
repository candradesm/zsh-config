/** @jsxImportSource @opentui/solid */
import type { TuiPlugin, TuiPluginModule } from "@opencode-ai/plugin/tui"
import { createSignal } from "solid-js"
import { JunglePromptIndicator } from "./jungle-mode/prompt-indicator"
import { registerJungleCommand, readJungleMode } from "./jungle-mode/command"

const tui: TuiPlugin = async (api) => {
  const initialEnabled = await readJungleMode()
  const [jungleEnabled, setJungleEnabled] = createSignal(initialEnabled)

  api.slots.register({
    order: 176,
    slots: {
      session_prompt_right(_ctx, props) {
        return <JunglePromptIndicator enabled={jungleEnabled} />
      },
      home_prompt_right(_ctx, props) {
        return <JunglePromptIndicator enabled={jungleEnabled} />
      },
    },
  })

  registerJungleCommand(api, jungleEnabled, setJungleEnabled)
}

const plugin: TuiPluginModule & { id: string } = {
  id: "jungle-mode",
  tui,
}

export default plugin
