# Android Development Setup Plan for LazyVim

> **STATUS: ✅ IMPLEMENTED**  
> **Date:** 2026-03-29  
> **Backup:** `~/.config/nvim.backup.20260329_133518`

## Overview

This document outlines the complete plan for configuring Neovim with LazyVim for modern Android development, supporting both Jetpack Compose and legacy View-based projects.

### Quick Start

```bash
# 1. Open Neovim
nvim

# 2. Install plugins
:Lazy

# 3. Install LSPs and tools
:Mason

# 4. Open an Android project to test
nvim /path/to/android-project
```

## Requirements

- Kotlin support (LSP, formatting, debugging)
- Java support (for interop and legacy code)
- XML support (Android layouts)
- Markdown support (documentation)
- Gradle support (build files)
- Auto-format on save
- Debugger support (Kotlin + Java)

---

## Prerequisites Status

### Already Installed ✅

| Tool | Version | Path |
|------|---------|------|
| Java JDK | 21.0.10 | `/usr/bin/java` |
| ADB | 1.0.41 | `~/Library/Android/sdk/platform-tools/adb` |
| Neovim | With LazyVim | `~/.config/nvim` |
| Gradle Wrapper | Per-project | Project-specific |

### Auto-Installed by Mason (LazyVim)

The following tools will be automatically installed when you open relevant files:

- `kotlin-language-server` - Kotlin LSP
- `ktlint` - Kotlin linter/formatter
- `kotlin-debug-adapter` - Kotlin debugger
- `jdtls` - Java Language Server
- `java-debug-adapter` - Java debugger
- `java-test` - Java test runner
- `marksman` - Markdown LSP
- `markdownlint-cli2` - Markdown linter
- `markdown-toc` - Markdown TOC generator

---

## Configuration Structure

### Files Created/Modified

```
~/.config/nvim/
├── lua/config/
│   └── lazy.lua                       # MODIFIED: Added extras imports
├── lua/plugins/
│   ├── android.lua                    # NEW: Core Android development setup
│   └── android-nice-to-have.lua       # NEW: Optional features (disabled)
├── ANDROID_DEV_SETUP.md               # This file
└── lazy-lock.json                     # Will be auto-updated
```

### Files to Backup

Before making changes, create backups:

```bash
# Full config backup
cp -r ~/.config/nvim ~/.config/nvim.backup.$(date +%Y%m%d_%H%M%S)

# Plugin lock backup
cp ~/.config/nvim/lazy-lock.json ~/.config/nvim/lazy-lock.json.backup
```

---

## Core Configuration (`android.lua`)

### 1. LazyVim Language Extras

Import official LazyVim extras for language support in `lua/config/lazy.lua`:

```lua
-- Core language support via LazyVim extras (MUST be before custom plugins)
{ import = "lazyvim.plugins.extras.lang.kotlin" },   -- Kotlin LSP, ktlint, debugger
{ import = "lazyvim.plugins.extras.lang.java" },     -- Java LSP, jdtls, debugger
{ import = "lazyvim.plugins.extras.lang.markdown" }, -- Markdown LSP, preview, linting
{ import = "lazyvim.plugins.extras.lang.toml" },     -- TOML support for version catalogs
```

**Important:** These imports must be in `lua/config/lazy.lua` BEFORE the `{ import = "plugins" }` line to avoid load order warnings.

**What this provides:**

| Feature | Kotlin | Java | Markdown | TOML |
|---------|--------|------|----------|------|
| LSP | ✅ kotlin-language-server | ✅ jdtls | ✅ marksman | ✅ Basic |
| Treesitter | ✅ kotlin | ✅ java | ✅ markdown | ✅ toml |
| Linting | ✅ ktlint | ✅ jdtls built-in | ✅ markdownlint | - |
| Formatting | ✅ ktlint | ✅ jdtls | ✅ prettier | - |
| Debugging | ✅ kotlin-debug-adapter | ✅ java-debug-adapter | - | - |

### 2. Auto-Format on Save

Enable formatting for Kotlin and Java files:

```lua
-- Enable format on save for Android development
{
  "stevearc/conform.nvim",
  opts = {
    formatters_by_ft = {
      kotlin = { "ktlint" },
      java = { "google-java-format" },
    },
    format_on_save = {
      timeout_ms = 500,
      lsp_fallback = true,
    },
  },
}
```

### 3. Gradle/Groovy Filetype Detection

Add autocmd for Gradle files:

```lua
-- Filetype detection for Gradle files
vim.api.nvim_create_autocmd({ "BufRead", "BufNewFile" }, {
  pattern = { "*.gradle", "*.gradle.kts" },
  callback = function()
    vim.bo.filetype = "groovy"
  end,
})
```

### 4. Debugger Configuration

Both Kotlin and Java debuggers will be configured with:

**Kotlin Debug Configs:**
- Launch current file
- Attach to running process (port 5005)
- Unit test runner

**Java Debug Configs:**
- Launch main class
- Attach to remote JVM (port 5005)
- Hot code replacement

---

## Nice-to-Have Features (`android-nice-to-have.lua`)

These features are **commented out by default** and can be enabled later.

### Option A: Full Android IDE Plugin

**Plugin:** `iamironz/android-nvim-plugin`

**Features:**
- Gradle task runner (`:AndroidBuild`, `:AndroidRun`, `:AndroidInstall`)
- ADB device management
- Interactive Logcat viewer
- AVD (Android Virtual Device) management
- APK building and deployment

**Installation:**
```lua
-- Uncomment to enable full Android IDE features
-- {
--   "iamironz/android-nvim-plugin",
--   dependencies = { "nvim-lua/plenary.nvim" },
--   config = function()
--     require("android").setup()
--   end,
-- }
```

### Option B: Terminal-Based ADB Integration

Simple keymaps using built-in terminal:

```lua
-- ADB shortcuts using terminal (uncomment to enable)
-- vim.keymap.set("n", "<leader>ad", ":terminal adb devices<CR>", { desc = "ADB Devices" })
-- vim.keymap.set("n", "<leader>al", ":terminal adb logcat<CR>", { desc = "ADB Logcat" })
-- vim.keymap.set("n", "<leader>ai", ":terminal adb install ", { desc = "ADB Install APK" })
```

### Testing Integration

Advanced test runner via nvim-dap:

```lua
-- Java/Kotlin test runner integration (uncomment to enable)
-- {
--   "nvim-neotest/neotest",
--   dependencies = {
--     "nvim-neotest/nvim-nio",
--     "nvim-lua/plenary.nvim",
--     "antoinemadec/FixCursorHold.nvim",
--     "nvim-treesitter/nvim-treesitter",
--   },
--   config = function()
--     require("neotest").setup({
--       adapters = {
--         -- Add Java/Kotlin adapters when available
--       },
--     })
--   end,
-- }
```

---

## Post-Installation Steps

After implementing the configuration:

1. **Open Neovim** and run `:Lazy` to install new plugins
2. **Run** `:Mason` to install language servers and tools
3. **Verify installations:**
   - Open a `.kt` file → kotlin-language-server should start
   - Open a `.java` file → jdtls should start
   - Open a `.md` file → marksman should start
4. **Test formatting:** Save a Kotlin file, ktlint should auto-format
5. **Test debugging:** Set a breakpoint and run debug configuration

---

## Troubleshooting

### Common Issues

**Issue:** kotlin-language-server not starting
- **Solution:** Run `:MasonInstall kotlin-language-server`

**Issue:** Java imports not organizing
- **Solution:** Use `<leader>co` (requires nvim-jdtls)

**Issue:** Formatter not working
- **Solution:** Check `:ConformInfo` for available formatters

**Issue:** Debugger not attaching
- **Solution:** Ensure port 5005 is available and app is in debug mode

### Useful Commands

| Command | Description |
|---------|-------------|
| `:Lazy` | Manage plugins |
| `:Mason` | Install LSPs/tools |
| `:LspInfo` | Check LSP status |
| `:ConformInfo` | Check formatters |
| `:DapContinue` | Start debugging |

---

## Result Summary

After setup, you'll have:

- ✅ Full IDE features for Kotlin (autocomplete, goto definition, rename, etc.)
- ✅ Full IDE features for Java (organize imports, extract methods, etc.)
- ✅ Auto-formatting on save for both languages
- ✅ Debugging support for both Kotlin and Java
- ✅ Markdown editing with live preview
- ✅ XML support for Android layouts (via treesitter)
- ✅ Gradle file detection and syntax highlighting
- ✅ TOML support for version catalogs
- 📋 Optional ADB integration ready to enable
- 📋 Optional testing integration ready to enable

---

## Next Steps

1. Review this plan
2. Approve for implementation
3. Run backup commands
4. Create configuration files
5. Test with an Android project

---

*Plan created for: LazyVim Android Development Setup*
*Date: $(date)*
