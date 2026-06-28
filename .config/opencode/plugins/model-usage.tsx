/** @jsxImportSource @opentui/solid */
import type { TuiPlugin, TuiPluginModule } from "@opencode-ai/plugin/tui"
import UsageSidebar from "./model-usage/sidebar"
import { registerUsageCommand } from "./model-usage/command"

const tui: TuiPlugin = async (api) => {
  api.slots.register({
    order: 175,
    slots: {
      sidebar_content(_ctx, props) {
        return <UsageSidebar api={api} session_id={props.session_id} />
      },
    },
  })
  registerUsageCommand(api)
}

const plugin: TuiPluginModule & { id: string } = {
  id: "model-usage",
  tui,
}

export default plugin
