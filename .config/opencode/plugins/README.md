# OpenCode Plugins

Two plugins for [OpenCode](https://opencode.ai/) — one TUI sidebar widget and one server notification handler.

## copilot-usage (TUI Plugin)

Sidebar widget that shows GitHub Copilot premium request usage when a `github-copilot` provider is active.

**Features:**
- Current session usage tracking (user prompts × model multiplier)
- Monthly quota from GitHub API (supports both paid and free plans)
- Progress bar with color coding (green < 75%, yellow < 90%, red >= 90%)
- Auto-refresh every 5 minutes + on session changes
- Model polling fallback for first-load race condition

**Files:**
- `copilot-usage.tsx` — Main plugin (SolidJS)
- `copilot-usage.config.json` — Model multiplier config
- `tui.json` — TUI plugin registration

**Requirements:**
- `GITHUB_TOKEN` env var for quota fetching (optional — shows warning if missing)

**Debug:** Set `OPENCODE_COPILOT_DEBUG=false` to disable logging. Logs go to `logs/` (gitignored).

## notifications (Server Plugin)

Desktop notifications for key session events.

**Notifications:**
- `session.idle` — "Task completed!" (subagent completions are filtered out)
- `session.error` — "Something went wrong, I need your attention!"
- `permission.asked` — "I need permission to do: <summary>" (debounced by type)
- `tool.execute.before` (question) — "I have a question for you!"

**Features:**
- Suppresses notifications when terminal is in focus (macOS + Linux)
- Sound support (macOS: `afplay`, Linux: `paplay`)
- Terminal auto-detection via `$TERM_PROGRAM` and parent process tree
- Configurable via `notifications.config.jsonc`

**Files:**
- `notifications.js` — Main plugin
- `notifications.config.jsonc` — JSONC config (comments allowed)

## Installation

Copy all files to `~/.config/opencode/`:

```bash
cp -r plugins/* ~/.config/opencode/plugins/
cp plugins/tui.json ~/.config/opencode/tui.json
```

The TUI plugin is registered in `tui.json`. The server plugin is auto-loaded from the `plugins/` directory.
