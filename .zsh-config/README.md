# Zsh Configuration Files

This directory contains modular zsh configuration files.

## Files

### nvim-config
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
| `GRADLE_TIMEOUT` | No | `60000` | Sync timeout (ms) |
| `GRADLE_FEEDBACK` | No | `medium` | Verbosity: minimal/medium/verbose |
| `GRADLE_CACHE_DIR` | No | `~/.cache/nvim/gradle` | Cache directory |

\* Required only for Android projects

**Keybindings:**
- `<leader>Gs` - Gradle Sync
- `<leader>Gf` - Gradle Force Sync  
- `<leader>Gc` - Clear Gradle Cache

**Commands:**
- `:GradleSync` - Sync dependencies
- `:GradleSyncForce` - Force re-sync
- `:GradleClearCache` - Clear cache
- `:AndroidInfo` - Show configuration status

**Works with:**
- ✅ Android apps
- ✅ Ktor servers
- ✅ Pure Kotlin projects
- ✅ Java projects
- ✅ Any Gradle-based project

**Troubleshooting:**
- If SDK not found: `export ANDROID_SDK_ROOT="/your/sdk/path"`
- Clear cache: `:GradleClearCache`

### custom-config.sh
General utility aliases and Java configuration.

### golden-wisdom.sh
Project navigation aliases.

### oh-my-zsh-config.sh
Oh-My-Zsh framework configuration.

### zara-custom-config.sh
Additional Zara-specific aliases.
