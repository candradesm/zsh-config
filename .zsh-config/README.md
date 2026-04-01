# Zsh Configuration Files

This directory contains modular zsh configuration files.

## Files

### nvim-config.sh

Environment variables for Neovim Gradle Development (Android, Ktor, pure Kotlin/Java).

> ⚠️ **Platform Support:** macOS and Linux only. Windows is not supported.

**Dependencies:**

- `fd` (file finder): `brew install fd` - Required for file search in LazyVim

**Setup:** Add to `~/.zshrc`:

```bash
source ~/.zsh-config/nvim-config
```

**Variables:**

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| **Android SDK** |
| `ANDROID_SDK_ROOT` | Yes* | `$HOME/Library/Android/sdk` | Path to Android SDK |
| `ANDROID_HOME` | Yes* | `$HOME/Library/Android/sdk` | Alternative SDK path |
| **Gradle Settings** |
| `GRADLE_CACHE` | No | `true` | Enable classpath caching |
| `GRADLE_JVM_TARGET` | No | `17` | JVM target (auto-detected) |
| `GRADLE_AUTO_SYNC` | No | `false` | Auto-sync on gradle save |
| `GRADLE_TIMEOUT` | No | `60000` | Sync timeout (ms) — Lua fallback when unset: `120000` |
| `GRADLE_FEEDBACK` | No | `medium` | Verbosity: minimal/medium/verbose |
| `GRADLE_CACHE_DIR` | No | `~/.cache/nvim/gradle` | Cache directory |

### custom-config.sh

General utility aliases and Java configuration.

### golden-wisdom.sh

Project navigation aliases.

### oh-my-zsh-config.sh

Oh-My-Zsh framework configuration.

### work.sh *(gitignored — create locally)*

Work-specific aliases, environment variables, and tooling. This file is listed in `.gitignore`
and will never be committed. Create it at `~/.zsh-config/work.sh` with your own work
environment content. It is sourced automatically from `.zshrc` with `2>/dev/null` so a
missing file is silently ignored.

**Example contents:** project navigation aliases, VPN helpers, internal SDK paths, etc.

### _credentials.sh *(gitignored — create locally)*

Stores credentials and secrets. This file is listed in `.gitignore` and will never be
committed. Create it at `~/.zsh-config/_credentials.sh` and add your `export` statements
there.

**CRITICAL**: Never share this file or commit it. If any key is exposed, rotate it immediately.
