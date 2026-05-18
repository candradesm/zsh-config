# JetBrains Kotlin LSP Setup

## Overview

The JetBrains `kotlin-lsp` (official Kotlin Language Server built on IntelliJ platform) is used
for Kotlin >= 2.3 projects. For older projects, `fwcd/kotlin-language-server` is used automatically.

- **Source**: [github.com/Kotlin/kotlin-lsp](https://github.com/Kotlin/kotlin-lsp)
- **Status**: Experimental / pre-alpha (as of 2025)
- **Supports**: JVM-only Kotlin Gradle projects with Gradle sync

## Installation

### Homebrew (Recommended)

```bash
brew install JetBrains/utils/kotlin-lsp
```

This installs the `kotlin-lsp` binary to your PATH. The Neovim plugin will detect it

### Verify Installation

```bash
kotlin-lsp --version
# Expected: LS-262.x.x or similar
```

## How Version Switching Works

The Neovim config automatically selects the appropriate LSP based on the project's Kotlin version:

| Kotlin Version | LSP Used | Statusline |
|---|---|---|
| < 2.3 | fwcd/kotlin-language-server (via Mason) | `KLS:fwcd` |
| >= 2.3 | JetBrains kotlin-lsp (via Homebrew) | `KLS:JB` |

Detection logic:
1. `find_project_root()` walks up from the current file to find `settings.gradle.kts`
2. `detect_kotlin_version()` reads `gradle/libs.versions.toml` at the project root
3. If Kotlin >= 2.3 AND `kotlin-lsp` is executable → JetBrains LSP activates
4. Otherwise → fwcd fallback (graceful degradation)

## Platform Support

| Platform | Supported |
|----------|-----------|
| macOS ARM64 (Apple Silicon) | ✅ |
| macOS x86_64 | ✅ |
| Linux x86_64 | ✅ |
| Linux ARM64 | ✅ |

> **Note**: On Linux without Homebrew, download the standalone binary from
> [Releases](https://github.com/Kotlin/kotlin-lsp/releases) and place it in your PATH.

## Requirements

- Java 17 or above (`echo $JAVA_HOME`)
- JVM-only Kotlin Gradle project
- `gradlew` at the project root (for Gradle sync)

## Troubleshooting

### LSP not activating for Kotlin 2.3+ project

1. Check if the binary is in PATH: `which kotlin-lsp`
2. Check if executable: `kotlin-lsp --version`
3. Check version detection: `:lua print(require("utils.gradle").detect_kotlin_version(vim.fn.getcwd()))`
4. Check root detection: `:lua print(require("utils.gradle").find_project_root(vim.fn.expand("%:p")))`

### Gradle sync errors (red diagnostics everywhere)

The JetBrains LSP performs a full Gradle sync. If any Gradle task fails during import,
dependency resolution won't work. Check the LSP log:

```vim
:lua vim.cmd('edit ' .. vim.lsp.get_log_path())
```

Search for `SEVERE` or `error` entries. Common causes:
- Missing `google-services.json` for certain build variants
- Network issues downloading dependencies
- Incompatible Gradle/AGP versions

### Wrong root directory detected

`find_project_root()` walks up the directory tree looking for `settings.gradle.kts`.
In multi-module projects, it correctly skips submodule `build.gradle.kts` files and finds the
actual root where `settings.gradle.kts` lives.

### Switching between LSPs

To force fwcd for a 2.3+ project (e.g., if kotlin-lsp is unstable):
```bash
brew uninstall kotlin-lsp
```
The config will automatically fall back to fwcd when `kotlin-lsp` is not in PATH.

## Updating

```bash
brew upgrade kotlin-lsp
```

Restart Neovim after updating for the new version to take effect.
