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
// Global default model (format: "providerID/modelID")
const model = api.state.config?.model // e.g. "github-copilot/claude-sonnet-4"

// Available providers
const providers = api.state.provider // ReadonlyArray<Provider>

// ✅ PREFERRED: Read model directly from UserMessage.model — it is a REQUIRED field in the
// OpenCode schema (never optional). Works for ALL user messages including compaction ones.
const messages = api.state.session.messages(sessionID) // NOTE: capped at 100
const userMsg = messages.find(m => m.role === "user")
if (userMsg) {
  const model = (userMsg as any).model as { providerID: string; modelID: string; variant?: string }
  // model.providerID e.g. "github-copilot", model.modelID e.g. "claude-sonnet-4"
}

// In a message.updated handler — read from the event payload directly:
api.event.on("message.updated", (event) => {
  const msg = event.properties.info
  if (msg.role !== "user") return
  const userModel = (msg as any).model as { providerID: string; modelID: string } | undefined
  // userModel?.providerID, userModel?.modelID — always set for user messages
})

// Fallback only: last assistant message's model (use only when UserMessage.model unavailable)
const lastAssistant = [...messages].reverse().find(m => m.role === "assistant")
if (lastAssistant) {
  // lastAssistant.providerID, lastAssistant.modelID (top-level on AssistantMessage, not nested)
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
4. **`UserMessage.model` is `{ providerID, modelID }`** (object, not a string) and is **REQUIRED** — it is always present on every user message (including compaction messages)
5. **`AssistantMessage` has `modelID` and `providerID`** as separate top-level fields (not nested under `model`)
6. **TUI plugins are NOT auto-loaded** — must register in `tui.json`
7. **Paths in `tui.json` resolve relative to the config file** — use `./` prefix
8. **`EventMessageUpdated`** has `{ type, properties: { sessionID, info: Message } }`
9. **TUI plugins fail silently if not registered** — check `tui.json` if plugin doesn't appear
10. **Never store `0` in a deduplication map to mark a message as "counted but skipped"** — this permanently blacklists the ID and prevents any future retry (e.g. if the model becomes available on a later `message.updated` fire)
11. **Always read `UserMessage.model` directly** — do NOT scan adjacent `AssistantMessage`s to infer the model; for the first message in a session no assistant has responded yet, making the scan return null and silently skip counting
12. **`session.compacted` is a BusEvent (ephemeral)** — it fires in real-time but is NOT replayed when loading historical sessions. To detect past compactions, scan messages for parts with `type: "compaction"`

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

> **SyncEvents** are persisted to the DB and replayed to clients when they connect or load a session.
> **BusEvents** are ephemeral — they fire in real-time only and are NOT replayed for historical sessions.

### Session events (SyncEvents unless noted)
```ts
EventSessionCreated   // { properties: { sessionID, info: Session } }
EventSessionUpdated   // { properties: { sessionID, info: Session } }
EventSessionDeleted   // { properties: { sessionID, info: Session } }
EventSessionIdle      // { properties: { sessionID } }          — BusEvent
EventSessionError     // { properties: { sessionID } }          — BusEvent
EventSessionCompacted // { properties: { sessionID } }          — BusEvent ⚠️ not replayed
EventSessionStatus    // { properties: { sessionID, status: SessionStatus } }
EventSessionDiff      // { properties: { sessionID, diff: FileDiff[] } } — BusEvent
```

`Session` has `parentID?: string` — sessions with `parentID` are subagent sessions.

### Message events (SyncEvents — all replayed on load)
```ts
EventMessageUpdated     // { properties: { sessionID, info: UserMessage | AssistantMessage } }
EventMessageRemoved     // { properties: { sessionID, messageID } }
EventMessagePartUpdated // { properties: { sessionID, part: Part, time: number } }
EventMessagePartRemoved // { properties: { sessionID, messageID, partID } }
```

**`EventMessageUpdated` fires for BOTH user and assistant message updates** (including streaming updates as the assistant responds). Filter by `msg.role`.

#### `UserMessage` shape (from OpenCode schema — all fields):
```ts
{
  id: string           // MessageID
  sessionID: string    // SessionID
  role: "user"
  model: {             // ⚠️ REQUIRED — never optional, always present
    providerID: string // e.g. "github-copilot"
    modelID: string    // e.g. "claude-sonnet-4"
    variant?: string
  }
  agent: string
  time: { created: number }
  // Optional fields:
  format?: OutputFormat
  summary?: { title?: string; body?: string; diffs: FileDiff[] }
  system?: string
  tools?: Record<string, boolean>
}
```

#### `AssistantMessage` shape (from OpenCode schema — key fields):
```ts
{
  id: string           // MessageID
  sessionID: string    // SessionID
  role: "assistant"
  parentID: string     // ← ID of the UserMessage that triggered this response
  modelID: string      // top-level (NOT nested under "model")
  providerID: string   // top-level (NOT nested under "model")
  mode: string         // "compaction" for compaction summary messages (deprecated)
  agent: string
  summary?: boolean    // true = this is a compaction summary assistant message
  cost: number         // 0 for compaction summaries
  tokens: {
    input: number; output: number; reasoning: number
    cache: { read: number; write: number }
    total?: number
  }
  time: { created: number; completed?: number }
  // Optional: error, path, structured, variant, finish
}
```

### Part types (`type` discriminator)

| `type` | Key fields | Notes |
|---|---|---|
| `"text"` | `text: string`, `synthetic?: boolean`, `ignored?: boolean` | `synthetic: true` = injected, not a real user input |
| `"reasoning"` | `text: string` | Model reasoning trace |
| `"tool"` | `callID`, `tool`, `state` | Tool call; state has `status: pending\|running\|completed\|error` |
| `"compaction"` | `auto: boolean`, `overflow?: boolean` | Marks a compaction user message |
| `"step-finish"` | `reason`, `cost`, `tokens` | End of an LLM response step |
| `"step-start"` | `snapshot?` | Start of an LLM response step |
| `"file"` | `mime`, `url`, `filename?`, `source?` | Attached file |
| `"patch"` | `hash`, `files: string[]` | Git patch |
| `"snapshot"` | `snapshot: string` | Filesystem snapshot |
| `"subtask"` | `prompt`, `description`, `agent`, `model?` | Subagent task |
| `"agent"` | `name`, `source?` | Agent invocation |
| `"retry"` | `attempt`, `error: APIError` | Retry event |

All parts share: `{ id: PartID, sessionID: SessionID, messageID: MessageID }`.

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

1. **`create()`** — Creates a **user message** with a `compaction` part type and `model` set to the current model
2. **`process()`** — Makes a **real LLM API call** to generate a summary (consumes a premium request)
3. **`process()`** — Creates an **assistant message** with `summary: true`, `cost: 0`, and `modelID`/`providerID` set
4. If auto mode and `result === "continue"`:
   - Creates a **synthetic "continue" user message** with `model` set (copied from triggering user message) and a text part with `synthetic: true`
5. Publishes `session.compacted` event (**BusEvent — ephemeral, not replayed on load**)

### Message types created

| Message | Role | Part type | `model` field? | Consumes premium request? |
|---|---|---|---|---|
| Compaction user message | `user` | `compaction` | ✅ Yes (required) | Yes (via LLM call) |
| Assistant summary | `assistant` | `text` (summary) | N/A (`modelID`/`providerID` set) | No (`cost: 0`) |
| Synthetic "continue" | `user` | `text` (`synthetic: true`) | ✅ Yes (copied from triggering msg) | No |

### Detecting message types

**In `message.updated` handler** — use `api.state.part(messageID)`:
```tsx
const parts = api.state.part(msg.id!) ?? []

// Detect compaction user message (1 premium request was consumed)
const isCompaction = parts.some((p) => p.type === "compaction")

// Detect synthetic "continue" message (NOT a premium request)
const isSynthetic = parts.some((p) => p.type === "text" && (p as any).synthetic === true)

// Regular user message — neither
```

**In `fetchSessionUsage` (load path)** — use `item.parts` from `api.client.session.messages()`:
```tsx
// api.client.session.messages() returns { info: Message, parts: Part[] }[]
// parts are available directly — no separate api.state.part() call needed
const parts = (item as any).parts as Part[] ?? []
const isSynthetic = parts.some(p => p.type === "text" && (p as any).synthetic === true)
```

> **Note**: `api.state.part()` works for historically loaded sessions — parts are hydrated from the DB via the SyncEvent replay mechanism.

### Recommended handling for usage-counting plugins

```tsx
// ✅ CORRECT: Read model from UserMessage.model — always present, even for compaction messages
const userModel = (msg as any).model as { providerID: string; modelID: string } | undefined
const model = userModel?.providerID && userModel?.modelID
  ? `${userModel.providerID}/${userModel.modelID}` : null

// Skip synthetic messages — they are not real premium requests
const parts = api.state.part(msg.id!) ?? []
const isSynthetic = parts.some(p => p.type === "text" && (p as any).synthetic === true)
if (isSynthetic) {
  return  // ✅ Just return — do NOT store in deduplication map (storing 0 blacklists the ID)
}

// Only store in deduplication map when you have a real counted result
if (model && isCopilotModel(model)) {
  const multiplier = getMultiplier(model, config)
  if (!messageMultipliers.has(msg.id)) {
    messageMultipliers.set(msg.id, multiplier)  // store ONLY positive results
    setUsage(prev => prev + multiplier)
  }
}

// session.compacted: refresh quota only — messages are already counted via message.updated
// ⚠️ session.compacted is a BusEvent — NOT replayed for historical sessions
api.event.on("session.compacted", () => {
  fetchQuota()
})
```

> **Why NOT to scan adjacent AssistantMessages for the model**: For the first message in a session, no assistant has responded yet — the scan returns null and the message is silently skipped. `UserMessage.model` is a required schema field and is always populated at message creation time.

---

## Step 10 — Counting session usage (premium requests)

### Key design principles

1. **Read `UserMessage.model` directly** — it is always set, even for compaction messages
2. **Only store in the deduplication map when counting** — do NOT store `0` for skipped messages; that permanently blacklists the ID
3. **Use `api.client.session.messages()` for the load path** — it returns `{ info, parts }[]` for all messages; `api.state.session.messages()` is capped at 100
4. **`session.compacted` is ephemeral** — for historical sessions, detect compaction by scanning for parts with `type: "compaction"`

### Load path — counting from session history

```tsx
async function countSessionUsage(sessionID: string, api: TuiPluginApi, config: MyConfig) {
  const result = await api.client.session.messages({ sessionID, limit: 10000 })
  const messages = result.data ?? []

  let total = 0
  const counted = new Map<string, number>() // deduplication

  for (const item of messages) {
    if (item.info?.role !== "user") continue

    // Parts are returned inline — no separate api.state.part() call needed
    const parts = ((item as any).parts ?? []) as Part[]

    // Skip synthetic "continue" messages (injected after compaction, not a real request)
    if (parts.some(p => p.type === "text" && (p as any).synthetic === true)) continue

    // Read model directly from UserMessage.model (REQUIRED field, always present)
    const infoModel = (item.info as any)?.model
    const model = infoModel?.providerID && infoModel?.modelID
      ? `${infoModel.providerID}/${infoModel.modelID}` : null

    if (!model || !model.toLowerCase().includes("copilot")) continue

    const multiplier = getMultiplier(model, config)
    const msgId = item.id ?? (item.info as any)?.id
    if (msgId) {
      counted.set(msgId, multiplier)
      total += multiplier
    }
  }

  return { total, counted }
}
```

### Live path — counting from `message.updated` events

```tsx
// Deduplication map: message ID → multiplier (only populated for counted messages)
const messageMultipliers = new Map<string, number>()

api.event.on("message.updated", (event) => {
  const msg = event.properties.info
  if (msg.role !== "user") return

  // Deduplication — message.updated fires multiple times per message
  if (msg.id && messageMultipliers.has(msg.id)) return

  // Skip synthetic messages
  const parts = (api.state.part(msg.id!) ?? []) as Part[]
  if (parts.some(p => p.type === "text" && (p as any).synthetic === true)) return

  // Read model from UserMessage.model (tier 1 — always preferred)
  const userModel = (msg as any)?.model as { providerID: string; modelID: string } | undefined
  let model = userModel?.providerID && userModel?.modelID
    ? `${userModel.providerID}/${userModel.modelID}` : null

  // Fallback tier 2: last assistant in session state (≤100 msgs)
  if (!model) {
    const msgs = api.state.session.messages(sessionID)
    for (let i = msgs.length - 1; i >= 0; i--) {
      if (msgs[i].role === "assistant" && msgs[i].providerID && msgs[i].modelID) {
        model = `${msgs[i].providerID}/${msgs[i].modelID}`
        break
      }
    }
  }

  // Fallback tier 3: globally configured model
  if (!model) model = api.state.config?.model ?? null

  if (!model || !model.toLowerCase().includes("copilot")) return

  const multiplier = getMultiplier(model, config)
  messageMultipliers.set(msg.id!, multiplier)  // store ONLY when counting
  setUsage(prev => prev + multiplier)
})
```

### Compaction messages — are they counted automatically?

Yes. The compaction user message has `UserMessage.model` set just like any other user message. It will be picked up by both the load path and the live path above without any special handling. Its parts have `type: "compaction"` (not `type: "text" && synthetic: true`), so it passes the synthetic filter and gets counted as 1 premium request.

---

## References
- OpenCode plugins docs: https://opencode.ai/docs/plugins/
- OpenTUI SolidJS bindings: https://opentui.com/docs/bindings/solid
- OpenTUI slots: https://opentui.com/docs/plugins/slots
- SDK type definitions: `@opencode-ai/sdk/v2` types
- TUI plugin types: `@opencode-ai/plugin/tui` types
- Real examples: this repo's `.config/opencode/plugins/copilot-usage.tsx` and `notifications.js`
