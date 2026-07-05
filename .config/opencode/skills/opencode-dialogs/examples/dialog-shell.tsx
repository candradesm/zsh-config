/** @jsxImportSource @opentui/solid */
import { onMount, onCleanup, createSignal } from "solid-js"
import { makeScrollState } from "./shared/scroll"
import { registerDialogKeyLayer } from "./shared/keys"

// ── Scroll state ───────────────────────────────────────────────────
const scroll = makeScrollState(createSignal)

function handleKey(key: string) {
  if (key === "up") return scroll.handleUp()
  if (key === "down") return scroll.handleDown()
  return false
}

// ── Dialog shell ───────────────────────────────────────────────────
function renderDialog() {
  const fg = theme?.foreground ?? "#ffffff"
  const muted = theme?.muted ?? "#888888"
  const red = theme?.red ?? "#ef4444"

  // Key layer
  let cleanupKeyLayer: (() => void) | null = null

  api.ui.dialog.replace(() => {
    onMount(() => {
      api.ui.dialog.setSize("large")

      cleanupKeyLayer = registerDialogKeyLayer(api, {
        bindings: [
          { key: "up",   cmd: "example.scrollUp",   desc: "Scroll up" },
          { key: "k",    cmd: "example.scrollUp",   desc: "Scroll up" },
          { key: "down", cmd: "example.scrollDown", desc: "Scroll down" },
          { key: "j",    cmd: "example.scrollDown", desc: "Scroll down" },
        ],
        commands: [
          { name: "example.scrollUp",   title: "Scroll Up",   run: async () => { handleKey("up") } },
          { name: "example.scrollDown", title: "Scroll Down", run: async () => { handleKey("down") } },
        ],
      })

      loadData()
    })

    onCleanup(() => {
      if (cleanupKeyLayer) {
        try { cleanupKeyLayer() } catch { /* ignore */ }
        cleanupKeyLayer = null
      }
    })

    return (
      <box paddingLeft={2} paddingRight={2} paddingBottom={1} flexDirection="column" gap={1}>
        {/* Title bar */}
        <box flexDirection="row" justifyContent="space-between">
          <box flexDirection="row" gap={1}>
            <text fg={fg}><b>Title</b></text>
            <text fg={muted}>— Subtitle</text>
          </box>
          <text fg={muted}>esc</text>
        </box>

        {/* More above indicator */}
        <text fg={muted}>{hasData && scroll.isScrolled() ? "▲ more above" : " "}</text>

        <scrollbox
          ref={(el) => scroll.scrollRef = el}
          flexDirection="column"
          gap={1}
          maxHeight={40}
          scrollbarOptions={{ visible: false }}
        >
          {loading() ? (
            <text fg={muted}>Loading…</text>
          ) : error() ? (
            <box flexDirection="column" gap={1}>
              <text fg={red}><b>Error</b></text>
              <text fg={muted}>{errorMsg()}</text>
            </box>
          ) : empty() ? (
            <text fg={muted}>No data.</text>
          ) : (
            <box paddingBottom={1}>
              {/* Content sections go here */}
            </box>
          )}
        </scrollbox>

        {/* More below indicator */}
        <text fg={muted}>{hasData && !scroll.isAtBottom() ? "▼ more below" : " "}</text>

        {/* Footer */}
        <text fg={muted}>↑↓ scroll  ·  esc close</text>
      </box>
    )
  })
}
