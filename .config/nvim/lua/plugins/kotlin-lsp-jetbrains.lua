-- JetBrains Kotlin LSP Configuration (kotlin-lsp)
-- Provides the official JetBrains Kotlin LSP for projects using Kotlin >= 2.3.
-- Falls back to fwcd/kotlin-language-server for Kotlin < 2.3 or when binary is not installed.
-- NOTE: kotlin-lsp is currently pre-alpha and may be unstable.
-- INSTALL: brew install JetBrains/utils/kotlin-lsp
-- See docs/kotlin-lsp-setup.md for details.

-- ==========================================
-- CACHING
-- ==========================================

-- Cache results per project root to avoid repeated filesystem I/O.
-- The root_dir function is called for every Kotlin file opened.
local _cache = {}
local _binary_available = nil
local _missing_binary_notified = false

-- ==========================================
-- AVAILABILITY CHECKS
-- ==========================================

local function is_kotlin_lsp_available()
  -- Only cache permanently when binary is found.
  -- If not found, re-check on next call (user may install mid-session via Homebrew).
  if not _binary_available then
    _binary_available = vim.fn.executable("kotlin-lsp") == 1

    if not _binary_available and not _missing_binary_notified then
      _missing_binary_notified = true
      vim.notify(
        "kotlin-lsp not found. Install with: brew install JetBrains/utils/kotlin-lsp",
        vim.log.levels.INFO,
        { title = "Kotlin LSP" }
      )
    end
  end
  return _binary_available
end

local function should_use_jetbrains_lsp(fname)
  if not is_kotlin_lsp_available() then
    return false
  end

  local gradle = require("utils.gradle")
  local root = gradle.find_project_root(fname)

  if not root then
    return false
  end

  -- Check cache first
  if _cache[root] ~= nil then
    return _cache[root]
  end

  -- Compute and cache
  local result = gradle.is_kotlin_2_3_or_higher(root)
  _cache[root] = result
  return result
end

local function kotlin_root_dir(fname)
  -- Use our own Gradle root detection (proven to work via statusline indicator)
  local gradle = require("utils.gradle")
  local root = gradle.find_project_root(fname)
  if root then
    return root
  end

  -- Fallback to lspconfig's built-in root pattern
  local util = require("lspconfig.util")
  return util.root_pattern("settings.gradle", "settings.gradle.kts", "build.gradle", "build.gradle.kts")(fname)
end

return {
  -- ==========================================
  -- KOTLIN LANGUAGE SERVER SELECTION
  -- ==========================================
  -- Both Kotlin LSP implementations use conditional root_dir functions so only
  -- one server can attach to a Kotlin project at a time.
  {
    "neovim/nvim-lspconfig",
    opts = {
      servers = {
        -- Override fwcd server: don't start if JetBrains LSP should be used.
        kotlin_language_server = {
          root_dir = function(bufnr, on_dir)
            -- Neovim 0.11+ root_dir uses callback pattern: call on_dir(root) to activate.
            -- Not calling on_dir prevents the server from starting for this buffer.
            local fname = vim.api.nvim_buf_get_name(bufnr)
            if fname == "" then
              return
            end

            if should_use_jetbrains_lsp(fname) then
              return
            end

            local root = kotlin_root_dir(fname)
            if root then
              on_dir(root)
            end
          end,
        },

        -- JetBrains kotlin-lsp: only start for Kotlin >= 2.3 projects when installed.
        kotlin_lsp = {
          mason = false,
          cmd = { "kotlin-lsp", "--stdio" },
          filetypes = { "kotlin" },
          root_dir = function(bufnr, on_dir)
            -- Neovim 0.11+ root_dir uses callback pattern: call on_dir(root) to activate.
            -- Not calling on_dir prevents the server from starting for this buffer.
            local fname = vim.api.nvim_buf_get_name(bufnr)
            if fname == "" then
              return
            end

            if not should_use_jetbrains_lsp(fname) then
              return
            end

            local root = kotlin_root_dir(fname)
            if root then
              on_dir(root)
            end
          end,
          single_file_support = false,
          settings = {},
        },
      },
    },
  },
}
