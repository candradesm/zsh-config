/** @jsxImportSource @opentui/solid */
import { onMount, onCleanup, createSignal } from "solid-js"

// ── Scroll state ───────────────────────────────────────────────────
let scrollRef: any = null
const [isScrolled, setIsScrolled] = createSignal(false)
const [isAtBottom, setIsAtBottom] = createSignal(false)

function handleKey(key: string) {
  if (key === "up") {
    scrollRef?.scrollBy?.(-10)
    setIsAtBottom(false)
    setTimeout(() => {
      if ((scrollRef?.scrollTop ?? 0) <= 0) setIsScrolled(false)
    }, 50)
    return true
  }
  if (key === "down") {
    scrollRef?.scrollBy?.(10)
    setIsScrolled(true)
    setTimeout(() => {
      const st = scrollRef?.scrollTop ?? 0
      const ch = scrollRef?.clientHeight ?? scrollRef?.height ?? 40
      const sh = scrollRef?.scrollHeight ?? 0
      setIsAtBottom(st + ch >= sh - 5)
    }, 50)
    return true
  }
  return false
}

// ── Dialog shell ───────────────────────────────────────────────────
function renderDialog() {
  const fg = theme?.foreground ?? "#ffffff"
  const muted = theme?.muted ?? "#888888"
  const red = theme?.red ?? "#ef4444"

  // Key layer
  let dialogKeyLayer: any = null

  api.ui.dialog.replace(() => {
    onMount(() => {
      api.ui.dialog.setSize("large")

      dialogKeyLayer = api.keymap.registerLayer({
        bindings: [
          { key: "up",   cmd: "example.scrollUp",   desc: "Scroll up" },
          { key: "k",    cmd: "example.scrollUp",   desc: "Scroll up" },
          { key: "down", cmd: "example.scrollDown", desc: "Scroll down" },
          { key: "j",    cmd: "example.scrollDown", desc: "Scroll down" },
        ],
        commands: [
          { name: "example.scrollUp",   title: "Scroll Up",   async run() { handleKey("up") } },
          { name: "example.scrollDown", title: "Scroll Down", async run() { handleKey("down") } },
        ],
      })

      loadData()
    })

    onCleanup(() => {
      if (dialogKeyLayer) {
        try { dialogKeyLayer() } catch { /* ignore */ }
        dialogKeyLayer = null
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
        <text fg={muted}>{hasData && isScrolled() ? "▲ more above" : " "}</text>

        <scrollbox
          ref={scrollRef}
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
        <text fg={muted}>{hasData && !isAtBottom() ? "▼ more below" : " "}</text>

        {/* Footer */}
        <text fg={muted}>↑↓ scroll  ·  esc close</text>
      </box>
    )
  })
}
