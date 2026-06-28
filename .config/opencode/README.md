# OpenCode Configuration

Configuration for [OpenCode](https://opencode.ai/) — agents, plugins, skills, and settings.

## Plugins

### jungle-mode (Server + TUI)

Jungle Mode plugin that injects a themed persona into primary agents (coordinator, plan, build) and subagents (developer, testing, qa, reviewer). Enabled/disabled via `/jungle` command or `Ctrl+Shift+M`.

**Server (`jungle-mode-server.ts`):** Injects jungle persona into all primary agents (coordinator 🦧, plan 🐵, build 🐵) via system prompt, and prepends persona to subagent messages.

**TUI (`jungle-mode.tsx`):** Sidebar indicator, `/jungle` toggle command, and prompt indicator showing jungle mode status.

**Personas:** Warrior Monke 🦧 (coordinator), Junior Monke 🐵 (plan/build), Junior Monke Developer 🐵 (developer), Assert Ape 🐒 (testing), Quality Quacker 🦆🔍 (qa), GOAT Roaster 🐐 (reviewer)

**Files:** `plugins/jungle-mode-server.ts`, `plugins/jungle-mode.tsx`, `plugins/jungle-mode/`

### model-usage (TUI)

Sidebar widget + `/usage` slash command (`Ctrl+Shift+U`) showing token usage and quota across providers.

**Sidebar:** Cost estimation (price-weighted input/output split from API) plus provider-specific quota:
- **GitHub Copilot** — premium request counting + monthly quota from GitHub API
- **opencode-go** — rolling (5h), weekly, and monthly quota scraped from opencode.ai

**`/usage` command:** Monthly token breakdown per model (top 10) with progress bars, queried from OpenCode's SQLite database.
- **Month navigation** — `←` `→` arrows to browse past months (cached instantly)
- **Reload** — `r` to refresh current month data
- **Scroll** — `↑` `↓` (or `j` `k`) with overflow hints (`▲` / `▼`)
- **Persistent cache** — past months saved to disk for instant recall

**Files:** `plugins/model-usage.tsx`, `plugins/model-usage.config.json`, `plugins/model-usage/`
**Requires:** `GITHUB_TOKEN` (for Copilot quota), `OPENCODE_GO_WORKSPACE_ID` + `OPENCODE_GO_AUTH_COOKIE` (for Go quota)
**Debug:** `OPENCODE_COPILOT_DEBUG=true` to enable logs

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
│   ├── model-usage.tsx              # TUI: usage sidebar + /usage command
│   ├── model-usage.config.json      # Model multipliers + deprecated
│   ├── model-usage/                 # Sub-modules (types, helpers, db, quota, sidebar, command)
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
