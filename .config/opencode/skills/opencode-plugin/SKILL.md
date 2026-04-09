---
name: opencode-plugin
description: "CRITICAL: Load when building or debugging OpenCode plugins. Missing this = silent failures, broken hooks, and wasted hours. Covers server vs TUI plugin types, event hooks, state API, SolidJS UI slots, config loading, and deployment. Works for ANY plugin type."
---

## When to use me
- Building a new OpenCode plugin (server or TUI)
- Debugging an existing plugin that doesn't load or behave correctly
- Understanding the OpenCode plugin API (`api.state`, `api.client`, `api.event`, slots)
- Working with OpenTUI SolidJS components in a TUI plugin
- Configuring plugin registration in `tui.json` or `opencode.json`

## Not intended for
- General SolidJS development outside OpenCode
- OpenCode SDK client usage (standalone scripts) → use SDK docs directly
- OpenCode configuration (providers, models, themes) → use `/config`

---

## Step 0 — Understand the two plugin systems

OpenCode has **two separate, mutually exclusive plugin systems**:

| | Server Plugin | TUI Plugin |
|---|---|---|
| **Purpose** | Hook into events, shell env, tools | UI in sidebar, commands, routes |
| **File ext** | `.js` or `.ts` | `.tsx` (JSX required) |
| **Export** | `export const MyPlugin = async ({ $, client, ... }) => { return hooks }` | `export default { id, tui }` |
| **Auto-loaded** | ✅ from `.opencode/plugins/` or `~/.config/opencode/plugins/` | ❌ must register in `tui.json` |
| **Config file** | `opencode.json` (optional, npm plugins) | `tui.json` (required) |
| **Types** | `Plugin` from `@opencode-ai/plugin` | `TuiPlugin`, `TuiPluginModule` from `@opencode-ai/plugin/tui` |

A single module can only be one type. `TuiPluginModule` has `server?: never`.

---

## Step 1 — Server plugin structure

```js
// .opencode/plugins/my-server-plugin.js
export const MyPlugin = async ({ project, client, $, directory, worktree }) => {
  // Initialization code runs once at plugin load

  return {
    // Event hooks
    event: async ({ event }) => {
      if (event.type === "session.idle") {
        // React to session becoming idle
      }
    },

    // Tool interception
    "tool.execute.before": async (input, output) => {
      // input.tool = tool name, output.args = tool arguments
    },
    "tool.execute.after": async (input, output) => {
      // output.title, output.output, output.metadata
    },

    // Shell environment injection
    "shell.env": async (input, output) => {
      output.env.MY_VAR = "value"
    },

    // Custom tools
    tool: {
      mytool: tool({
        description: "Does something",
        args: { foo: tool.schema.string() },
        async execute(args, context) {
          return `Result: ${args.foo}`
        },
      }),
    },

    // Session compaction customization
    "experimental.session.compacting": async (input, output) => {
      output.context.push("## Custom context...")
    },
  }
}
```

### Available server events

```
session.created, session.updated, session.deleted, session.idle,
session.error, session.compacted, session.status, session.diff
permission.asked, permission.replied
message.updated, message.removed, message.part.updated, message.part.removed
tool.execute.before, tool.execute.after
file.edited, file.watcher.updated
shell.env, command.executed
server.connected, installation.updated
lsp.client.diagnostics, lsp.updated
todo.updated
```

### Server plugin context fields

| Field | Description |
|---|---|
| `project` | Current project information |
| `directory` | Current working directory |
| `worktree` | Git worktree path |
| `client` | OpenCode SDK client for API calls |
| `$` | Bun's shell API for executing commands |

### Config file loading (server plugins)

Use `new URL("./config.json", import.meta.url).pathname` to resolve paths relative to the plugin file. Use `Bun.file()` for reading.

```js
const configPath = new URL("./my-plugin.config.json", import.meta.url).pathname
const configFile = Bun.file(configPath)
const config = (await configFile.exists())
  ? JSON.parse(await configFile.text())
  : defaultConfig
```

---

## Step 2 — TUI plugin structure

```tsx
// .opencode/plugins/my-tui-plugin.tsx
/** @jsxImportSource @opentui/solid */
import type { TuiPlugin, TuiPluginModule, TuiPluginApi } from "@opencode-ai/plugin/tui"
import { createSignal, createEffect, createMemo, onCleanup } from "solid-js"

function MyComponent(props: { api: TuiPluginApi; session_id: string }) {
  // SolidJS component with reactive state
  return <box flexDirection="column" gap={0}>
    <text fg="#ffffff">Hello from plugin!</text>
  </box>
}

const tui: TuiPlugin = async (api) => {
  api.slots.register({
    order: 175, // position in sidebar
    slots: {
      sidebar_content(_ctx, props) {
        return <MyComponent api={api} session_id={props.session_id} />
      },
    },
  })
}

const plugin: TuiPluginModule & { id: string } = {
  id: "my-tui-plugin",
  tui,
}

export default plugin
```

### TUI plugin registration in `tui.json`

**Critical**: TUI plugins MUST be registered in `tui.json`. They are NOT auto-loaded.

**Location**: `~/.config/opencode/tui.json` (global) or `.opencode/tui.json` (project).

**Path resolution**: Relative paths resolve relative to the `tui.json` file location. Use `./` prefix:

```json
{
  "$schema": "https://opencode.ai/tui.json",
  "plugin": ["./plugins/my-tui-plugin.tsx"]
}
```

The opencode repo itself uses this pattern: `./plugins/tui-smoke.tsx` in `.opencode/tui.json`.

### Sidebar slots

| Slot | Mode | Props | Notes |
|---|---|---|---|
| `sidebar_title` | `single_winner` | `{ session_id, title, share_url? }` | Replaces title area |
| `sidebar_content` | additive (default) | `{ session_id }` | Main content, ordered by `order` |
| `sidebar_footer` | `single_winner` | `{ session_id }` | Replaces version info |

**Built-in order values**:

| Plugin | Order |
|---|---|
| `internal:sidebar-context` | 100 |
| `internal:sidebar-mcp` | 200 |
| `internal:sidebar-lsp` | 300 |
| `internal:sidebar-todo` | 400 |
| `internal:sidebar-files` | 500 |

Use `175` to insert between context and MCP. Use `> 500` to appear below all built-ins.

---

## Step 3 — TuiPluginApi reference

| Field | Description |
|---|---|
| `api.state` | Reactive SolidJS-backed state (sessions, messages, parts, providers, config) |
| `api.state.config` | `SdkConfig` — has `model?: string` in `"provider/model"` format |
| `api.state.provider` | `ReadonlyArray<Provider>` — each has `{ id, name, source, env, models }` |
| `api.state.session.messages(sessionID)` | `ReadonlyArray<Message>` — **capped at 100** |
| `api.state.part(messageID)` | `ReadonlyArray<Part>` for a message |
| `api.client` | Full SDK client — use for data beyond 100-msg cap |
| `api.event.on(type, handler)` | Subscribe to events; returns unsubscribe fn |
| `api.kv` | Persistent key-value store (`get`/`set`/`ready`) |
| `api.lifecycle.onDispose(fn)` | Plugin-level cleanup; returns unregister fn |
| `api.slots.register(plugin)` | Register UI slots; returns slot id |
| `api.ui` | `toast()`, `dialog`, `Dialog`, `DialogSelect`, `Slot`, `Prompt` |
| `api.theme` | Current theme colors (`foreground`, `muted`, etc.) |
| `api.command.register(cb)` | Register slash commands; returns unregister fn |
| `api.route` | Register routes, navigate |

### Reading the active model/provider

```tsx
// Global default model
const model = api.state.config?.model // e.g. "github-copilot/claude-sonnet-4"

// Available providers
const providers = api.state.provider // ReadonlyArray<Provider>

// Last assistant message's model (session-specific)
const messages = api.state.session.messages(sessionID)
const lastAssistant = [...messages].reverse().find(m => m.role === "assistant")
if (lastAssistant) {
  // lastAssistant.providerID, lastAssistant.modelID
}
```

### Fetching messages beyond the 100 cap

```tsx
const result = await api.client.session.messages({
  sessionID: props.session_id,
  limit: 10000,
})
// result.data: Array<{ info: Message, parts: Part[] }>
```

---

## Step 4 — SolidJS patterns for TUI plugins

### Component lifecycle

```tsx
function MyComponent(props: { api: TuiPluginApi; session_id: string }) {
  const [data, setData] = createSignal(null)

  // Re-runs when session_id changes (reactive)
  createEffect(() => {
    const sessionID = props.session_id // MUST read synchronously for tracking
    fetchData(sessionID).then(setData) // Use .then(), NOT async/await

    const unsub = props.api.event.on("session.compacted", handler)
    onCleanup(unsub) // Cleanup on re-run or unmount
  })

  return <text>{data() ?? "Loading..."}</text>
}
```

### Critical: NEVER use async/await inside createEffect

Reactive tracking stops at the first `await`. Capture values synchronously, then use `.then()`:

```tsx
// WRONG — breaks reactivity
createEffect(async () => {
  const id = props.session_id
  const data = await fetchData(id) // ❌ reactivity lost after await
  setData(data)
})

// CORRECT — preserves reactivity
createEffect(() => {
  const id = props.session_id // tracked
  fetchData(id).then(setData) // ✅ closure captures id
})
```

### Component-level cleanup (NOT api.lifecycle)

Inside SolidJS components, use `onCleanup` — NOT `api.lifecycle.onDispose`:

```tsx
createEffect(() => {
  const unsub = props.api.event.on("message.updated", handler)
  onCleanup(unsub) // runs when effect re-runs or component unmounts
})
```

`api.lifecycle.onDispose` is for plugin-level cleanup only (in the `tui` function scope).

### Polling fallback for first-load race condition

If `api.state` isn't populated on first render, use a polling interval as fallback:

```tsx
const modelPoller = setInterval(() => {
  const detected = detectModel(props.api)
  if (detected !== currentModel()) {
    setCurrentModel(detected)
  }
}, 2000)

onCleanup(() => clearInterval(modelPoller))
```

### Never return null from the root component

Returning `null` causes the component to unmount. Use conditional rendering inside a persistent container:

```tsx
// WRONG — unmounts the component
if (!isActive()) return null
return <box>...</box>

// CORRECT — keeps component mounted
return (
  <box flexDirection="column" gap={0}>
    {isActive() ? <box>...</box> : null}
  </box>
)
```

---

## Step 5 — OpenTUI components

### Layout
- `<box>` — Container with `flexDirection`, `gap`, `border`, `padding`, `backgroundColor`
- `<scrollbox>` — Scrollable container
- `<text>` — Styled text with `fg`, `bg`, `content` props

### Text modifiers (inside `<text>`)
- `<strong>`, `<b>` — Bold
- `<em>`, `<i>` — Italic
- `<span>` — Inline styled text
- `<br>` — Line break

### Colors
Use hex strings: `"#ffffff"`, `"#22c55e"`, `"#eab308"`, `"#ef4444"`, `"#888888"`

Access theme colors via `api.theme.current`:
```tsx
<text fg={api.theme.current?.foreground ?? "#ffffff"}>Text</text>
<text fg={api.theme.current?.muted ?? "#888888"}>Dim text</text>
```

---

## Step 6 — Debugging

### Logging (TUI plugin)

Use `fs.appendFileSync` — **NOT `Bun.write`** (append mode is broken):

```tsx
import { mkdirSync, appendFileSync } from "node:fs"

const DEBUG = process.env.MY_PLUGIN_DEBUG !== "false"
const logPath = new URL("./logs/my-plugin.log", import.meta.url).pathname
if (DEBUG) mkdirSync(new URL("./logs", import.meta.url).pathname, { recursive: true })

const log = (...args: unknown[]) => {
  if (!DEBUG) return
  const line = `[${new Date().toISOString()}] ${args.map(String).join(" ")}\n`
  appendFileSync(logPath, line)
}
```

### Logging (server plugin)

```js
await client.app.log({
  body: { service: "my-plugin", level: "info", message: "Something happened" },
})
```

### Common pitfalls

1. **`Bun.write` with `{ append: true }` overwrites** — use `fs.appendFileSync`
2. **`api.state.provider` is a `ReadonlyArray`**, not a single object — use `(api.state.provider ?? [])` for null safety
3. **`api.state.session.messages(sessionID)` requires `sessionID`** as argument
4. **`UserMessage.model` is `{ providerID, modelID }`** (object), not a string
5. **`AssistantMessage` has `modelID` and `providerID`** as separate fields
6. **TUI plugins are NOT auto-loaded** — must register in `tui.json`
7. **Paths in `tui.json` resolve relative to the config file** — use `./` prefix
8. **`EventMessageUpdated`** has `{ type, properties: { sessionID, info: Message } }`
9. **TUI plugins fail silently if not registered** — check `tui.json` if plugin doesn't appear

---

## Step 7 — Deployment

### File layout

```
~/.config/opencode/
├── tui.json                    ← TUI plugin registration
├── plugins/
│   ├── my-tui-plugin.tsx       ← TUI plugin (SolidJS)
│   ├── my-tui-plugin.config.json
│   ├── my-server-plugin.js     ← Server plugin (hooks)
│   ├── my-server-plugin.config.jsonc
│   └── logs/                   ← .gitignore'd debug logs
```

### Sync pattern (dotfiles repo)

When maintaining plugins in a dotfiles repo, copy files to `~/.config/opencode/`:
```bash
cp .config/opencode/plugins/*.tsx ~/.config/opencode/plugins/
cp .config/opencode/plugins/*.js ~/.config/opencode/plugins/
cp .config/opencode/plugins/*.json* ~/.config/opencode/plugins/
cp .config/opencode/plugins/tui.json ~/.config/opencode/tui.json
```

### .gitignore

Add to root `.gitignore`:
```
.config/opencode/plugins/logs/
```

---

## Step 8 — Event types reference

### Session events
```ts
EventSessionCreated   // { properties: { sessionID, info: Session } }
EventSessionUpdated   // { properties: { sessionID, info: Session } }
EventSessionDeleted   // { properties: { sessionID } }
EventSessionIdle      // { properties: { sessionID } }
EventSessionError     // { properties: { sessionID } }
EventSessionCompacted // { properties: { sessionID } }
EventSessionStatus    // { properties: { sessionID, status: SessionStatus } }
```

`Session` has `parentID?: string` — sessions with `parentID` are subagent sessions.

### Message events
```ts
EventMessageUpdated  // { properties: { sessionID, info: Message } }
```

`Message` = `UserMessage | AssistantMessage`:
- `UserMessage`: `{ role: "user", model: { providerID, modelID } }`
- `AssistantMessage`: `{ role: "assistant", modelID, providerID }`

### Permission events
```ts
EventPermissionAsked   // { properties: { id, permission, metadata, ... } }
EventPermissionReplied // { properties: { ... } }
```

### Tool events
```ts
EventToolExecuteBefore // { properties: { tool, sessionID, callID } }
EventToolExecuteAfter  // { properties: { tool, sessionID, callID } }
```

---

## Step 9 — Session compaction internals

When a session is compacted, OpenCode performs these steps (source: `packages/opencode/src/session/compaction.ts`):

### What happens during compaction

1. **`create()`** — Creates a **user message** with a `compaction` part type
2. **`process()`** — Makes a **real LLM API call** to generate a summary (consumes a premium request)
3. **`process()`** — Creates an **assistant message** with `mode: "compaction"`, `summary: true`, `cost: 0`
4. If auto mode and `result === "continue"`:
   - Creates a **synthetic "continue" user message** with a text part that has `synthetic: true`
5. Publishes `session.compacted` event

### Message types created

| Message | Role | Part type | Consumes premium request? |
|---|---|---|---|
| Compacted user message | `user` | `compaction` | Yes (via LLM call in `process()`) |
| Assistant summary | `assistant` | `text` (summary) | No (`cost: 0`) |
| Synthetic "continue" | `user` | `text` (`synthetic: true`) | No (just a text injection) |

### Detecting message types in `message.updated`

Use `api.state.part(messageID)` to inspect message parts:

```tsx
// In message.updated handler:
const parts = api.state.part(msg.id!)

// Detect compaction message
const isCompaction = parts.some((p) => p.type === "compaction")

// Detect synthetic "continue" message
const isSynthetic = parts.some((p) => p.type === "text" && p.synthetic === true)

// Regular user message — neither compaction nor synthetic
```

### Recommended handling for quota tracking plugins

```tsx
// message.updated: skip synthetic messages, count everything else
if (isSynthetic) {
  messageMultipliers.set(msg.id, 0) // track but don't count
  return
}

// session.compacted: just refresh quota, messages are counted in message.updated
api.event.on("session.compacted", () => {
  fetchQuota()
  log("session.compacted: quota refreshed")
})
```

---

## References
- OpenCode plugins docs: https://opencode.ai/docs/plugins/
- OpenTUI SolidJS bindings: https://opentui.com/docs/bindings/solid
- OpenTUI slots: https://opentui.com/docs/plugins/slots
- SDK type definitions: `@opencode-ai/sdk/v2` types
- TUI plugin types: `@opencode-ai/plugin/tui` types
- Real examples: this repo's `.config/opencode/plugins/copilot-usage.tsx` and `notifications.js`
