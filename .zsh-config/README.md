# Zsh Configuration Files

This directory contains modular zsh configuration files.

## Files

### nvim-config.sh

Environment variables for Neovim Gradle Development (Android, Ktor, pure Kotlin/Java).

> ⚠️ **Platform Support:** macOS and Linux only. Windows is not supported.

**Dependencies:**

- `fd` (file finder): `brew install fd` - Required for file search in LazyVim

**Setup:** This file is sourced automatically from `.zshrc`. No manual setup needed.

**Variables:**

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| **Android SDK** |
| `ANDROID_SDK_ROOT` | Yes* | `$HOME/Library/Android/sdk` | Path to Android SDK |
| `ANDROID_HOME` | Yes* | `$HOME/Library/Android/sdk` | Alternative SDK path |
| **Gradle Settings** |
| `GRADLE_JVM_TARGET` | No | `17` | JVM target (auto-detected from project) |

\* Required only for Android projects. The kotlin-language-server handles its own Gradle sync internally.

### custom-config.sh

General utility aliases and Java configuration.

### golden-wisdom.sh

Project navigation aliases and welcome message.

### oh-my-zsh-config.sh

Oh-My-Zsh framework configuration with plugins: git, timer, thefuck, zsh-autosuggestions, zsh-syntax-highlighting.

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
