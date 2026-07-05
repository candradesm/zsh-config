# `/analyze` — Session Token Analysis Command

Provider-agnostic token breakdown via TUI dialog. Four-tier system-token resolution, tabbed layout, per-fragment system breakdown, auto-poll, and raw-text visor.

## Architecture

```
model-usage-server.ts  →  system-tokens.json  →  analyze.tsx (TUI)
  (server plugin)           (disk cache)          (dialog + render)
       ↑                                            ↑
  system.transform                               client.session.messages()
  captures full system                           reads ALL messages
```

### Files

| File | Role |
|---|---|
| `model-usage-server.ts` | Server plugin — hooks `experimental.chat.system.transform`, captures full system prompt + fragment breakdown |
| `model-usage/analyze.tsx` | TUI plugin — `/analyze` dialog, reads messages + system snapshot, renders tabs |
| `model-usage/helpers.ts` | Shared utilities — `splitSystemFragments`, `rawPromptTokens`, `estimateTokens`, `scaleEntries` |
| `model-usage/types.ts` | Shared types — `SystemSnapshot`, `SystemFragment`, `SystemSource` |
| `model-usage/db.ts` | Tier 1 reader — reads `session_context_epoch.baseline` from OpenCode V2 DB |

## Token Categories

| Category | Source | Method |
|---|---|---|
| **USER** | Non-synthetic `type: "text"` parts from user messages | char/4 |
| **ASSISTANT** | `type: "text"` parts from assistant messages | char/4 |
| **TOOLS** | `type: "tool"` (state completed): output + call arguments | char/4 |
| **REASONING** | `type: "reasoning"` parts | scaled to `tokens.reasoning` telemetry |
| **SYSTEM** | See tiered resolution below | varies |

REASONING entries are estimated with char/4, then proportionally scaled to match the provider-reported `tokens.reasoning` sum. ASSISTANT stays char/4 — using `tokens.output` would double-count tool-call generation already in TOOLS.

## Tiered System Resolution

```
Tier 1: baseline DB (session_context_epoch.baseline) → char/4
Tier 2: first nonzero assistant telemetry → formula subtraction
Tier 3: server plugin snapshot → char/4 (contaminated/compacted, ⚠)
Tier 4: none (0)
```

### Tier 1 — Baseline DB
Reads `session_context_epoch.baseline` from `opencode.db` (V2 native runner). This is the exact assembled system text — most accurate. Char/4 tokenization.

### Tier 2 — Telemetry (clean first call)
Used when Tier 1 is unavailable AND `cache.read === 0` on the first nonzero-input assistant. The formula:

```
raw = tokens.input + tokens.cache.read + tokens.cache.write
system = raw - conversationBeforeFirstAssistant
```

Where `conversationBeforeFirstAssistant` = sum of user + assistant + tool + reasoning tokens counted UP TO (but not including) the first nonzero-input assistant.

**Key insight**: OpenCode's `session.ts:366` computes `adjustedInputTokens = inputTokens - cacheRead - cacheWrite` before storing to `tokens.input`. To recover the raw prompt size, we must ADD both cache counters back. This is provider-agnostic.

### Tier 3 — Server Plugin
Fallback for contaminated (cache.read > 0) or compacted sessions. Uses the server plugin's char/4 snapshot. Displayed with ⚠ suffix.

### Tier 4 — None
No system data available. SYSTEM omitted from output.

## Server Plugin (`model-usage-server.ts`)

Hooks `experimental.chat.system.transform` to capture the fully assembled system prompt (post jungle-mode, post all plugins).

### Behavior
- **First measurement**: stores `{t, ts, fragments, rawText}` to disk
- **Material change** (>32 tokens drift): stores new measurement (latest wins)
- **No change** (≤32): refreshes timestamp every 5min, otherwise no-op
- **Compaction** (<70% of previous): overwrites with new, smaller measurement
- **Backfill**: if a legacy entry has empty fragments, stores rawText on the next matching call
- **Title-gen skip**: ignores title-generator calls (mirrors jungle-mode-server.ts)
- **Purge**: FIFO — cap 1000 entries, evict 100 oldest
- **Serialized writes**: Promise chain prevents race conditions from concurrent subagent calls

### Persistence
`~/.config/opencode/plugins/model-usage/system-tokens.json`
```json
{
  "ses_xxx": {
    "t": 5297,
    "ts": 1783174293379,
    "fragments": [{ "label": "Skills", "tokens": 1036 }, ...],
    "rawText": "<full system prompt>"
  }
}
```

## Fragment Splitting (`splitSystemFragments`)

Pure function that splits the assembled system prompt into labelled fragments:

1. **Markdown headers** (`### Heading`) — each header starts a new fragment
2. **XML sections** — `<available_references>`, `<mcp_instructions>`, `<available_skills>` captured as labelled blocks
3. **Jungle-mode injection** — `Instructions from: jungle-mode/*` enters "plugin mode" which collects content until double blank line (the boundary between injected persona and original system). Other `Instructions from:` markers (e.g. `AGENTS.md` file references) are regular section headers that do NOT enter plugin mode
4. **Preamble text** before any header bucketed as "preamble"

Fragment labels are truncated to 48 chars. Sorted by tokens descending. Capped at 100 fragments (excess merged into "other").

## `/analyze` TUI Dialog

### Tabs
- **Context** — all categories with percentage bar charts and total
- **Per-Tool** — tool-level breakdown in TOOLS category
- **System** — per-fragment system breakdown; appears when system has ≥2 fragments
- **Top** — top-10 contributors across all categories

Tabs are dynamic: System only shows when fragments ≥2, Per-Tool only when tools present.

### Keys
| Key | Action |
|---|---|
| `←` `h` | Previous tab |
| `→` `l` | Next tab |
| `↑` `k` | Scroll up |
| `↓` `j` | Scroll down |
| `v` | Toggle raw system prompt visor (System tab) |
| `r` | Manual reload |
| `esc` | Close |

### Auto-poll
Background reload every 60 seconds via `setInterval`. Uses `backgroundReload()` which increments a `loadGeneration` counter and re-fetches — stale responses are discarded if superseded by a newer reload.

### No-flash reload
Manual `r` reload keeps old data visible. Loading spinner only shows when `categories().length === 0`.

### Scroll indicators
"▲ more above" / "▼ more below" based on actual `scrollHeight > clientHeight` comparison, not just data presence.

### Raw visor
When `v` is pressed on the System tab, replaces the fragment list with the full system prompt text (up to 50,000 chars). Resets on tab switch.

## Key Design Decisions

- **Provider-agnostic**: char/4 estimation throughout. No real tokenizer dependency.
- **Keep-latest**: server plugin stores the latest measurement, not the largest. Jungle-mode injects on every call so latest IS most accurate.
- **Compaction**: compaction does NOT create a new session — the same session ID continues with a smaller system prompt. The <70% threshold detects this.
- **Jungle-mode per-call injection**: `jungle-mode-server.ts` injects persona on every API call (not per-session dedup). Guard: `JUNGLE_MARKER = "Instructions from: jungle-mode/primary-agent-persona"`.
- **Plugin load order**: `jungle-mode-server.ts` loads before `model-usage-server.ts` alphabetically (j < m), so jungle injects first, then model-usage captures.
- **No npm/bun dependencies** beyond OpenCode SDK and SolidJS.

## Limitations

- **token** estimation: all categories use char/4. Not a real tokenizer. REASONING is the only category with provider-reported exact values (via `tokens.reasoning` scaling).
- **No Tier 1 on V1**: `session_context_epoch` is a V2-only table. V1 / AI SDK fall through to Tier 2/3.
- **`` removal**: `<system-reminder>` blocks in the assembled prompt are currently not split as separate XML sections — they fall into adjacent fragments.
- **Session-must-exist**: `/analyze` requires an active session. No historical session browser.
