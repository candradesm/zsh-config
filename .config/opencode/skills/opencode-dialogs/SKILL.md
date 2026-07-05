---
name: opencode-dialogs
description: "IMPORTANT: Load when creating or modifying a dialog in any OpenCode TUI plugin. Enforces consistent spacing, layout, color, and interaction patterns. Missing this = dialogs with inconsistent UX across plugins."
---

## When to use me
- Adding a new dialog to any OpenCode TUI plugin
- Modifying the layout or spacing of an existing dialog
- Reviewing a dialog PR for UX consistency
- Fixing a spacing or alignment bug in a dialog

## Not intended for
- Sidebar components — those follow different layout rules
- Non-dialog UI (toasts, prompts) — OpenCode's built-in patterns

---

## Command Registration

Every dialog command registers via `api.keymap.registerLayer`. See `examples/command-registration.tsx` for the skeleton.

Rules:
- `name` and `slashName` must match (e.g. `analyze.show` / `"analyze"`)
- Keyboard shortcut must not conflict with existing bindings
- `category: "Plugin"`, `namespace: "palette"` — always the same

---

## Dialog Shell

Every dialog uses this outer structure. See `examples/dialog-shell.tsx` for the full skeleton.

| Rule | Correct | Wrong |
|---|---|---|
| Outer padding | `paddingLeft={2} paddingRight={2} paddingBottom={1}` | `padding={2}` |
| Title bar | Always present, even in error/empty/guard states | Missing "esc" or title |
| Content wrapper | `<box paddingBottom={1}>` — **no `gap` prop** | `<box gap={1}>` — causes double-spacing |
| Between sections | `<text> </text>` — single blank line | `─` rules, double blank lines |
| Between entries | `gap={1}` on a wrapper `<box>` | `<text> </text>` spacers between entries |
| Scroll indicators | Always reserve space with `" "` when hidden | Conditional rendering that shifts layout |
| Bars | `buildBar(pct, 50)` — width 50, on own line | Custom widths, bars inline sharing a line |

---

## Title Bar

```tsx
<box flexDirection="row" justifyContent="space-between">
  <box flexDirection="row" gap={1}>
    <text fg={fg}><b>Title</b></text>
    <text fg={muted}>— Subtitle</text>
  </box>
  <text fg={muted}>esc</text>
</box>
```

- Bold title in `fg` color
- Subtitle in `muted` color, prefixed with `—` (em dash U+2014, not hyphen `-`)
- `esc` in `muted` on the far right
- **Must appear in every dialog state**: data, loading, error, empty, and pre-dialog guard states

---

## Scroll Indicators

```tsx
// Above scrollbox
<text fg={muted}>{hasData && isScrolled() ? "▲ more above" : " "}</text>

// Below scrollbox
<text fg={muted}>{hasData && !isAtBottom() ? "▼ more below" : " "}</text>
```

- Always render a `<text>` — use `" "` as placeholder when hidden to prevent layout shift
- Show only when content overflows (hide during loading/error/empty states)

### Scroll state tracking

```tsx
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
```

---

## Dialog Key Layer

Register inside `onMount`, clean up in `onCleanup`:

```tsx
let dialogKeyLayer: any = null

onMount(() => {
  api.ui.dialog.setSize("large")

  dialogKeyLayer = api.keymap.registerLayer({
    bindings: [
      { key: "up",   cmd: "xxx.scrollUp",   desc: "Scroll up" },
      { key: "k",    cmd: "xxx.scrollUp",   desc: "Scroll up" },
      { key: "down", cmd: "xxx.scrollDown", desc: "Scroll down" },
      { key: "j",    cmd: "xxx.scrollDown", desc: "Scroll down" },
    ],
    commands: [
      { name: "xxx.scrollUp",   title: "Scroll Up",   async run() { handleKey("up") } },
      { name: "xxx.scrollDown", title: "Scroll Down", async run() { handleKey("down") } },
    ],
  })

  loadData() // start async data fetch
})

onCleanup(() => {
  if (dialogKeyLayer) {
    try { dialogKeyLayer() } catch { /* ignore */ }
    dialogKeyLayer = null
  }
})
```

- Binding namespaced to the dialog: `xxx.scrollUp`, `xxx.scrollDown`
- Always use `try/catch` on cleanup — the layer may already be disposed
- Dialog size: `"large"` for data-heavy dialogs, `"medium"` for simple messages

### Navigation dialogs

If the dialog has left/right navigation in addition to scroll, add those bindings too:

```tsx
{ key: "left",  cmd: "xxx.navLeft",  desc: "Previous" },
{ key: "h",     cmd: "xxx.navLeft",  desc: "Previous" },
{ key: "right", cmd: "xxx.navRight", desc: "Next" },
{ key: "l",     cmd: "xxx.navRight", desc: "Next" },
```

---

## Content Wrapper

Everything inside the scrollbox data state:

```tsx
<box paddingBottom={1}>
  {/* sections */}
</box>
```

- **`paddingBottom={1}` only — NO `gap` prop**
- All spacing is explicit via `<text> </text>` elements
- Never use `flexDirection="column" gap={1}` on the content wrapper

---

## Entry Patterns

See `examples/entry-patterns.tsx` for full code.

### Entry with bar (categories, tools, models)

- Wrap entries in `<box flexDirection="column" gap={1}>` for between-entry spacing
- Each entry is a `<box flexDirection="column" gap={1}>` with name, stats line, bar
- NO `<text> </text>` spacers between entries — `gap={1}` on the wrapper handles it
- Bar is always on its own line, width 50

### Single-line entry (numbered lists)

- Wrap in `<box flexDirection="column" gap={0}>` — entries are single-line
- Numbers use `padStart(2)` for fixed-width alignment
- Label uses `padEnd(24)` for column alignment

---

## Section Headers and Separators

- Headers in `fg` bold
- One blank line after header, one blank line before next section header
- **Never use horizontal rules** — blank lines only
- Conditional sections carry their own spacing inside the fragment

---

## Summary / Total Line

```tsx
<text fg={fg}>Total: {value} units ({context})</text>
```

- In `fg` (not bold, not muted)
- Context in parentheses: e.g. `(90 msgs)` or `($12.34)`
- Surrounded by `<text> </text>` above and below for section separation

---

## Footer

```tsx
{/* Scroll-only dialog */}
<text fg={muted}>↑↓ scroll  ·  esc close</text>

{/* Navigation dialog */}
<text fg={muted}>t today  ·  ← → month  ·  r reload  ·  ↑↓ scroll</text>
```

- In `muted` color
- Separators use `·` (middle dot U+00B7) with spaces: `  ·  `
- Only shown when data is loaded

---

## States

See `examples/states.tsx` for full code.

### Loading

```tsx
<text fg={muted}>Loading description…</text>
```

### Error

```tsx
<box flexDirection="column" gap={1}>
  <text fg={red}><b>Error Title</b></text>
  <text fg={muted}>{errorMsg()}</text>
</box>
```

### Empty

```tsx
<text fg={muted}>No data for this view.</text>
```

### Pre-dialog guard

Must include the title bar with "esc". Dialog size: `"medium"`.

---

## Color Conventions

| Element | Color |
|---|---|
| Bold titles, entry names, bars, values, totals | `fg` (foreground, `#ffffff`) |
| Stats, subtitles, hints, muted text, "esc" | `muted` (`#888888`) |
| Errors | `red` (`#ef4444`) |

```tsx
const fg = theme?.foreground ?? "#ffffff"
const muted = theme?.muted ?? "#888888"
const red = theme?.red ?? "#ef4444"
```

---

## Bar Conventions

| Property | Value |
|---|---|
| Function | `buildBar(percentage, 50)` from `helpers.ts` |
| Width | 50 characters |
| Filled char | `\u2588` (full block) |
| Empty char | `\u2591` (light shade) |
| Line color | `fg` |
| Position | Own line, after stats line, inside entry box |

Each bar is proportional to the entry's percentage of the **total** (not relative to the largest entry).

---

## References
- `model-usage/command.tsx` — reference: navigation + scroll dialog (`/usage`)
- `model-usage/analyze.tsx` — reference: scroll-only dialog (`/analyze`)
- `model-usage/helpers.ts` — shared utilities (`buildBar`, `fmt`)
- `opencode-plugin` skill — OpenCode plugin API patterns
