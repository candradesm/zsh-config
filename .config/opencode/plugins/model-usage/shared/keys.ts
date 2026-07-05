import type { TuiPluginApi } from "@opencode-ai/plugin/tui"

export interface KeyBinding {
  key: string
  cmd: string
  desc: string
}

export interface KeyCommand {
  name: string
  title: string
  run: () => Promise<void> | void
}

export interface KeyLayerConfig {
  bindings: KeyBinding[]
  commands: KeyCommand[]
}

/**
 * Register a dialog-scoped key layer on the TUI API.
 * Returns a cleanup function — call it in onCleanup to unregister.
 */
export function registerDialogKeyLayer(
  api: TuiPluginApi,
  config: KeyLayerConfig,
): () => void {
  return api.keymap.registerLayer(config)
}
