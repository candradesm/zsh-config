# OpenCode Configuration

Configuration for [OpenCode](https://opencode.ai/) — agents, plugins, skills, and settings.

## Plugins

### model-usage (TUI)

Sidebar widget + `/usage` slash command showing token usage and quota across providers.

**Sidebar:** Cost estimation (price-weighted input/output split from API) plus provider-specific quota:
- **GitHub Copilot** — premium request counting + monthly quota from GitHub API
- **opencode-go** — rolling (5h), weekly, and monthly quota scraped from opencode.ai

**`/usage` command:** Monthly token breakdown per model (top 10) with progress bars, queried from OpenCode's SQLite database.

**Files:** `plugins/model-usage.tsx`, `plugins/model-usage.config.json`, `plugins/model-usage/`
**Requires:** `GITHUB_TOKEN` (for Copilot quota), `OPENCODE_GO_WORKSPACE_ID` + `OPENCODE_GO_AUTH_COOKIE` (for Go quota)
**Debug:** `OPENCODE_COPILOT_DEBUG=true` to enable logs

### notifications (Server)

Desktop notifications for session events.

- Task completed, errors, permission requests, questions
- Suppresses when terminal is in focus (macOS + Linux)
- Sound support, configurable via `notifications.config.jsonc`
- Subagent completion filtering, permission type debouncing

**Files:** `plugins/notifications.js`, `plugins/notifications.config.jsonc`

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
| Coordinator (Jungle) | `.agents/the-jungle/coordinator.md` |
| Coordinator (Boring) | `.agents/boring/coordinator.md` |
| Main | `AGENTS.md` |
| Kotlin variant | `AGENTS-kotlin.md` |

## File Structure

```
~/.config/opencode/
├── AGENTS.md                        # Main agent instructions
├── AGENTS-kotlin.md                 # Kotlin-specific agent variant
├── .agents/
│   ├── the-jungle/
│   │   ├── coordinator.md           # Jungle coordinator agent prompt
│   │   └── subagents/
│   │       ├── developer.md
│   │       ├── qa.md
│   │       ├── reviewer.md
│   │       └── testing.md
│   └── boring/
│       ├── coordinator.md           # Professional coordinator agent prompt
│       └── subagents/
│           ├── implementation-agent.md
│           ├── quality-agent.md
│           ├── review-agent.md
│           └── test-agent.md
├── opencode.json                    # Server config (providers, etc.)
├── tui.json                         # TUI plugin registration
├── plugins/
│   ├── model-usage.tsx              # TUI: usage sidebar + /usage command
│   ├── model-usage.config.json      # Model multipliers + deprecated
│   └── model-usage/                 # Sub-modules (types, helpers, db, quota, sidebar, command)
│   ├── notifications.js             # Server: Desktop notifications
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
