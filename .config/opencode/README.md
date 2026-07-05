# OpenCode Configuration

Configuration for [OpenCode](https://opencode.ai/) — agents, plugins, skills, and settings.

## Plugins

### jungle-mode (Server + TUI)

Jungle Mode plugin that injects a themed persona into primary agents (coordinator, plan, build) and subagents (developer, testing, qa, reviewer). Enabled/disabled via `/jungle` command or `Ctrl+Shift+M`.

**Server (`jungle-mode-server.ts`):** Injects jungle persona into all primary agents (coordinator 🦧, plan 🐵, build 🐵) via system prompt on every API call (per-call, not per-session). Uses content-based agent detection (`detectPrimaryAgent`) as fallback when `chat.message` hook ordering varies, and prepends persona to subagent messages.

**TUI (`jungle-mode.tsx`):** Sidebar indicator, `/jungle` toggle command, and prompt indicator showing jungle mode status.

**Personas:** Warrior Monke 🦧 (coordinator), Junior Monke 🐵 (plan/build), Junior Monke Developer 🐵 (developer), Assert Ape 🐒 (testing), Quality Quacker 🦆🔍 (qa), GOAT Roaster 🐐 (reviewer)

**Files:** `plugins/jungle-mode-server.ts`, `plugins/jungle-mode.tsx`, `plugins/jungle-mode/`

### model-usage (Server + TUI)

Sidebar widget, `/usage` monthly breakdown, and `/analyze` per-session context breakdown.

**Server (`model-usage-server.ts`):** Hooks `experimental.chat.system.transform` to capture the fully-assembled system prompt on every main-chat call. Skips title-generator fires, re-measures on each qualifying call (keeps the latest — the system can grow mid-session as refs/MCP/skills load), and persists a per-fragment char/4 breakdown to `system-tokens.json`. Used by `/analyze` for the System Breakdown rows.

**Sidebar:** Cost estimation (price-weighted input/output split from API) plus provider-specific quota:
- **GitHub Copilot** — premium request counting + monthly quota from GitHub API
- **opencode-go** — rolling (5h), weekly, and monthly quota scraped from opencode.ai

**`/usage` command (`Ctrl+Shift+U`):** Monthly token breakdown per model (top 10) with progress bars, queried from OpenCode's SQLite database.
- **Month navigation** — `←` `→` arrows to browse past months, hard-capped at earliest database record. Dynamic arrow hints show available directions.
- **Today** — `t` to jump back to the current month
- **Reload** — `r` to refresh current month data
- **Scroll** — `↑` `↓` (or `j` `k`) with overflow hints (`▲` / `▼`)
- **Persistent cache** — past months saved to disk for instant recall

**`/analyze` command (`Ctrl+Shift+A`):** Per-session context token breakdown for the open session. Categorises every message part into SYSTEM / USER / ASSISTANT / TOOLS / REASONING.
- **Tabbed layout** — `←` `→` (or `h` `l`) to switch between Context, Per-Tool, System, and Top tabs.
  - **Context:** all categories with percentage bars and session total.
  - **Per-Tool:** tool-level token breakdown (output + call arguments) grouped by tool name.
  - **System:** per-fragment system token breakdown (agent prompt, instructions, env, skills, MCP, refs, jungle persona…). System fragments are split from the assembled prompt via markdown headers, XML section tags, and jungle-mode plugin injection boundaries. The tab only appears when the system has ≥2 fragments.
  - **Top:** top-10 contributors across all categories.
- **System tokens (tiered, provider-agnostic):**
  1. **Tier 1 — baseline DB** (V2 native runner): reads `session_context_epoch.baseline` from `opencode.db`, the exact assembled system text. Tokenised with char/4.
  2. **Tier 2 — telemetry** (when Tier 1 is unavailable, provider-agnostic): reconstitutes the raw prompt from the first assistant with `tokens.input > 0` as `raw = input + cache.read + cache.write`, then `system = raw − conversation_before`. Only used when `cache.read === 0` (clean first call); works for opencode-go, Copilot, Anthropic, Bedrock, OpenAI.
  3. **Tier 3 — server plugin** (contaminated/compacted): char/4 from `system-tokens.json` when telemetry is contaminated (`cache.read > 0`, e.g. resumed sessions) or the session was compacted. Shown with ⚠.
  4. **Tier 4** — no data; SYSTEM omitted.
- **Breakdown scaling:** when a Tier 1/2 total is available AND server fragments exist, fragments are scaled proportionally to sum to the authoritative total (current composition, exact total).
- **Raw visor** — `v` on the System tab toggles the full assembled system prompt text (up to 50,000 chars).
- **Auto-poll** — background reload every 60s so the dialog stays in sync as the conversation grows. No data is cleared or scroll reset on background fetches.
- **Scroll** — `↑` `↓` (or `j` `k`) with overflow hints (`▲` / `▼`)
- **Reload** — `r` to re-fetch and recalculate (use mid-conversation to watch the breakdown update as the session grows)

**Files:** `plugins/model-usage.tsx`, `plugins/model-usage-server.ts`, `plugins/model-usage/` (analyze, command, sidebar, db, helpers, quota, types)
**Requires:** `GITHUB_TOKEN` (for Copilot quota), `OPENCODE_GO_WORKSPACE_ID` + `OPENCODE_GO_AUTH_COOKIE` (for Go quota)
**Debug:** `OPENCODE_COPILOT_DEBUG=true` to enable logs (written to `plugins/logs/`)
**Tests:** `bun test plugins/model-usage/analyze.test.ts`

### notifications (Server)

Desktop notifications for session events.

- Task completed, errors, permission requests, questions
- Suppresses when terminal is in focus (macOS + Linux)
- Sound support, configurable via `notifications.config.jsonc`
- Subagent completion filtering, permission type debouncing

**Files:** `plugins/notifications.ts`, `plugins/notifications.config.jsonc`

## Skills

| Skill | Description |
|---|---|
| `opencode-plugin` | Guide for building server and TUI plugins |
| `code-review` | Code quality review (BLOCKER/ROAST/PRAISE) |
| `scan-project` | Scan new projects, create memory bank |
| `bootstrapper` | Onboard repos lacking documentation |

## Agents

| Agent | Config |
|---|---|
| Coordinator | `.agents/coordinator.md` |
| Developer | `.agents/subagents/developer.md` |
| Testing | `.agents/subagents/testing.md` |
| QA | `.agents/subagents/qa.md` |
| Reviewer | `.agents/subagents/reviewer.md` |
| Main | `AGENTS.md` |
| Kotlin variant | `AGENTS-kotlin.md` |

## File Structure

```
~/.config/opencode/
├── AGENTS.md                        # Main agent instructions
├── AGENTS-kotlin.md                 # Kotlin-specific agent variant
├── .agents/
│   ├── coordinator.md               # Coordinator agent prompt (Jungle Mode)
│   └── subagents/
│       ├── developer.md             # Developer agent prompt
│       ├── qa.md                    # QA agent prompt
│       ├── reviewer.md              # Reviewer agent prompt
│       └── testing.md               # Testing agent prompt
├── opencode.json                    # Server config (providers, etc.)
├── tui.json                         # TUI plugin registration
├── plugins/
│   ├── jungle-mode.tsx              # TUI: jungle-mode UI components
│   ├── jungle-mode-server.ts        # Server: chat.message hook for jungle persona injection
│   ├── jungle-mode/                 # Sub-modules (persona, types, UI fragments)
│   ├── model-usage.tsx              # TUI: usage sidebar + /usage + /analyze commands
│   ├── model-usage-server.ts        # Server: system prompt capture (experimental.chat.system.transform)
│   ├── model-usage.config.json      # Model multipliers + deprecated
│   ├── model-usage/                 # Sub-modules (analyze, command, sidebar, db, helpers, quota, types)
│   ├── notifications.ts             # Server: Desktop notifications
│   ├── notifications.config.jsonc   # Notification settings
│   └── logs/                        # Debug logs (gitignored)
├── skills/
│   ├── opencode-plugin/SKILL.md
│   ├── code-review/SKILL.md
│   ├── scan-project/SKILL.md
│   └── bootstrapper/SKILL.md
└── README.md                        # This file
```

## Installation

Files are copied from this repo's `.config/opencode/` to `~/.config/opencode/` during setup.
See [root README](../../README.md) for installation instructions.
