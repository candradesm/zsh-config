# OpenCode Configuration

Configuration for [OpenCode](https://opencode.ai/) — agents, plugins, skills, and settings.

## Plugins

### copilot-usage (TUI)

Sidebar widget showing GitHub Copilot premium request usage.

- Session usage tracking (user prompts × model multiplier)
- Monthly quota from GitHub API (paid and free plans)
- Progress bar with color coding (green/yellow/red)
- Auto-refresh every 5 minutes

**Files:** `plugins/copilot-usage.tsx`, `plugins/copilot-usage.config.json`, `plugins/tui.json`
**Requires:** `GITHUB_TOKEN` env var (optional)
**Debug:** `OPENCODE_COPILOT_DEBUG=false` to disable logs

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
| Coordinator | `.agents/coordinator.md` |
| Main | `AGENTS.md` |
| Kotlin variant | `AGENTS-kotlin.md` |

## File Structure

```
~/.config/opencode/
├── AGENTS.md                        # Main agent instructions
├── AGENTS-kotlin.md                 # Kotlin-specific agent variant
├── .agents/
│   └── coordinator.md               # Coordinator agent prompt
├── opencode.json                    # Server config (providers, etc.)
├── tui.json                         # TUI plugin registration
├── plugins/
│   ├── copilot-usage.tsx            # TUI: Copilot usage sidebar
│   ├── copilot-usage.config.json    # Model multipliers
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
