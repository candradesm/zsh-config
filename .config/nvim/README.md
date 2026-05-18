# Neovim Configuration (LazyVim)

Complete LazyVim configuration with Android/Kotlin development support.

## Features

- **Kotlin & Java LSP** — autocomplete, goto definition, refactoring, hover docs (auto-switches between fwcd and JetBrains LSP based on Kotlin version)
- **Android Development** — SDK detection, XML layout support
- **Auto-formatting** — ktlint for Kotlin, google-java-format for Java (on save)
- **Debugging** — Kotlin debugger with attach-to-process support
- **Statusline Indicators** — shows Android/Gradle project status

## Keyboard Shortcuts

### Custom Shortcuts

| Shortcut | Action |
|----------|--------|
| `<leader>cl` | Check LSP health (`:checkhealth lsp`) |

### Commands

| Command | Action |
|---------|--------|
| `:AndroidInfo` | Show Android development configuration status |

### LazyVim Defaults (Summary)

This config uses [LazyVim](https://www.lazyvim.org/) as the base. Key default shortcuts:

| Category | Key Shortcuts |
|----------|---------------|
| **Windows** | `<leader>ww` (next), `<leader>wv` (vertical split), `<leader>ws` (horizontal split), `<leader>wd` (close) |
| **Editing** | `<leader>y` (yank to clipboard), `<leader>/` (toggle comment), `gc` (visual comment) |
| **Diagnostics** | `<leader>xx` (all), `<leader>xX` (buffer), `[d`/`]d` (prev/next) |
| **Search** | `<leader>sf` (files), `<leader>sg` (grep), `<leader>sw` (word under cursor) |
| **LSP** | `<leader>ca` (code action), `<leader>cd` (definition), `<leader>cr` (references/rename), `<leader>cf` (format) |
| **Buffers** | `<leader>bb` (switch), `<leader>bn`/`<leader>bp` (next/prev), `<leader>bd` (delete) |
| **Git** | `<leader>gb` (blame), `<leader>gB` (browse), `<leader>gd` (diff) |
| **Selection** | `v` (char-wise), `V` (line-wise), `ggVG` (entire file) |

For the full list, see the [LazyVim Keymaps documentation](https://www.lazyvim.org/keymaps).

## Installation

```bash
# Clone this repo and copy nvim config
cp -r ~/.config-temp/.config/nvim ~/.config/nvim

# Open Neovim to auto-install plugins
nvim

# Inside nvim, run:
:Mason
```

## Android Development

This config provides full IDE support for Android/Kotlin development.

### What's Included

- **Kotlin & Java LSP** — autocomplete, goto definition, hover docs, refactoring
- **Auto-formatting** — ktlint for Kotlin, google-java-format for Java (runs on save)
- **XML support** — syntax highlighting for Android layouts
- **Debugger** — Kotlin debugger with attach-to-process (port 5005)
- **Statusline** — shows "Android" or "Gradle" indicator when in a project
- **SDK detection** — auto-detects SDK from `ANDROID_SDK_ROOT` or common paths (`~/Library/Android/sdk`, `~/Android/Sdk`)

### Quick Start

1. Open any `.kt` or `.java` file in an Android project
2. LSP will auto-start and provide IDE features
3. Use `:Mason` to install missing tools if needed
4. Run `:AndroidInfo` to check SDK path, JVM target, and project status

### Environment Variables

- `ANDROID_SDK_ROOT` — Android SDK path (auto-detected if not set)
- `GRADLE_JVM_TARGET` — JVM target version (auto-detected from project)
- `GRADLE_CACHE` — enable/disable Gradle caching (default: `true`)

### Optional Extras

The file `lua/plugins/android-extras.lua` contains disabled-by-default plugins for:

- **Full Android IDE** (`android-nvim-plugin`) — `:AndroidBuild`, `:AndroidRun`, `:AndroidLogcat`, `:AndroidDevices`, `:AndroidEmulator`
- **Terminal ADB shortcuts** — `<leader>ad` (devices), `<leader>al` (logcat), `<leader>ai` (install APK)
- **Gradle task runner** — `<leader>gb` (build), `<leader>gt` (test), `<leader>gc` (clean), `<leader>gr` (custom task)

Uncomment the sections you want in that file to enable them.

## Kotlin LSP (Version-Based Switching)

This configuration automatically selects the appropriate Kotlin LSP based on your project's Kotlin version:

| Kotlin Version | LSP Server | Source |
|---------------|------------|--------|
| ≤ 2.2.x | `kotlin-language-server` (fwcd) | Installed via Mason (automatic) |
| ≥ 2.3.0 | `kotlin-lsp` (JetBrains) | Installed via Mason (automatic) |

### How It Works

- The config detects the Kotlin version from your project's Gradle files (`libs.versions.toml`, `build.gradle.kts`, `build.gradle`, or `gradle.properties`)
- If Kotlin ≥ 2.3 **and** the `kotlin-lsp` binary is installed, the JetBrains LSP is used
- Otherwise, the fwcd `kotlin-language-server` is used as fallback
- Both servers are never active simultaneously on the same project

### Installing JetBrains kotlin-lsp

Both Kotlin LSP servers are installed **automatically via Mason** when Neovim starts. No manual installation is required.

For JetBrains kotlin-lsp setup details, see [docs/kotlin-lsp-setup.md](docs/kotlin-lsp-setup.md).

> [!WARNING]
> The JetBrains kotlin-lsp is in **pre-alpha** stage. It works for JVM Gradle projects but may have rough edges.

If Mason fails to install `kotlin-lsp`, you can install it manually via Homebrew as a fallback:

```bash
# macOS / Linux (Homebrew) — only if Mason fails
brew install JetBrains/utils/kotlin-lsp
```

Requirements:
- Java 17+
- Neovim 0.10+ (required for pull-based diagnostics)
- Gradle JVM project (KMP, Maven not yet supported)

### Verifying Which LSP Is Active

The statusline shows which Kotlin LSP is attached to the current buffer:
- **`KLS:JB`** (green) — JetBrains kotlin-lsp is active (Kotlin ≥ 2.3)
- **`KLS:fwcd`** (blue) — fwcd kotlin-language-server is active (Kotlin ≤ 2.2)

You can also run `:LspInfo` to see detailed server information.

## Troubleshooting

### Kotlin LSP not working

- Check LSP health: `<leader>cl`
- Verify kotlin-language-server is installed: `:Mason`
- Check logs: `:LspLog`

### Version compatibility

- **Kotlin ≤ 2.2.x** — uses `kotlin-language-server` (fwcd), installed automatically via Mason
- **Kotlin ≥ 2.3.0** — uses `kotlin-lsp` (JetBrains), installed automatically via Mason
- If version detection fails, fwcd server is used as safe fallback
- Version is auto-detected from Gradle files (libs.versions.toml, settings.gradle.kts, build.gradle.kts, build.gradle, gradle.properties)
- The statusline shows `KLS:JB` or `KLS:fwcd` to indicate which server is active
