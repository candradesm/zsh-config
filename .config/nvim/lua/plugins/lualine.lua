-- Lualine Statusline Customizations
-- Consolidates all statusline indicators into a single plugin spec.
-- Uses event-driven caching to avoid filesystem I/O on every statusline redraw.
-- NOTE: lazy.nvim only calls ONE opts function per plugin — multiple specs
-- with opts = function() will overwrite each other.

-- ============================================
-- BUFFER STATE CACHE
-- ============================================
-- Updated via autocmds (BufEnter, LspAttach, LspDetach).
-- Lualine functions read from this cache with zero I/O.

local _buf_state = {}
-- Structure: _buf_state[bufnr] = {
--   is_gradle = bool,
--   is_android = bool,
--   sdk_configured = bool,
--   kotlin_lsp_active = "jb" | "fwcd" | nil,
-- }

-- ============================================
-- LAZY MODULE RESOLUTION
-- ============================================
-- Resolve dependencies once on first use, not on every BufEnter.

local _gradle = nil
local _android = nil

local function get_gradle()
  if not _gradle then
    local ok, mod = pcall(require, "utils.gradle")
    if ok then _gradle = mod end
  end
  return _gradle
end

local function get_android()
  if not _android then
    local ok, mod = pcall(require, "utils.android")
    if ok then _android = mod end
  end
  return _android
end

-- ============================================
-- STATE UPDATE FUNCTIONS
-- ============================================

local function update_gradle_state(bufnr)
  local state = _buf_state[bufnr] or {}

  local gradle = get_gradle()
  local android = get_android()

  if not gradle or not android then
    state.is_gradle = false
    state.is_android = false
    state.sdk_configured = false
    _buf_state[bufnr] = state
    return
  end

  local filepath = vim.api.nvim_buf_get_name(bufnr)
  if filepath == "" then
    filepath = vim.fn.getcwd()
  end

  local project_root = gradle.find_project_root(filepath)
  state.is_gradle = project_root ~= nil

  if project_root then
    state.is_android = android.is_android_project(filepath)
    if state.is_android then
      local config = android.get_config()
      state.sdk_configured = config.is_sdk_configured
    else
      state.sdk_configured = false
    end
  else
    state.is_android = false
    state.sdk_configured = false
  end

  _buf_state[bufnr] = state
end

local function update_kotlin_lsp_state(bufnr)
  local state = _buf_state[bufnr] or {}

  local ft = vim.bo[bufnr].filetype
  if ft ~= "kotlin" then
    state.kotlin_lsp_active = nil
    _buf_state[bufnr] = state
    return
  end

  local jb = vim.lsp.get_clients({ bufnr = bufnr, name = "kotlin_lsp" })
  if #jb > 0 then
    state.kotlin_lsp_active = "jb"
  else
    local fwcd = vim.lsp.get_clients({ bufnr = bufnr, name = "kotlin_language_server" })
    if #fwcd > 0 then
      state.kotlin_lsp_active = "fwcd"
    else
      state.kotlin_lsp_active = nil
    end
  end

  _buf_state[bufnr] = state
end

-- ============================================
-- AUTOCMD REGISTRATION
-- ============================================

-- Update Gradle state on buffer/directory events
vim.api.nvim_create_autocmd({ "BufEnter", "BufRead", "DirChanged" }, {
  group = vim.api.nvim_create_augroup("LualineGradleCache", { clear = true }),
  callback = function(ev)
    update_gradle_state(ev.buf)
  end,
})

-- Update Kotlin LSP state on attach/detach events
vim.api.nvim_create_autocmd({ "LspAttach", "LspDetach" }, {
  group = vim.api.nvim_create_augroup("LualineKotlinLspCache", { clear = true }),
  callback = function(ev)
    -- Schedule to next event loop tick (LSP state is fully settled)
    vim.schedule(function()
      if vim.api.nvim_buf_is_valid(ev.buf) then
        update_kotlin_lsp_state(ev.buf)
        vim.cmd("redrawstatus")
      end
    end)
  end,
})

-- Update Kotlin LSP state on BufEnter (in case LSP attached while buffer was hidden)
vim.api.nvim_create_autocmd("BufEnter", {
  group = vim.api.nvim_create_augroup("LualineKotlinLspBufEnter", { clear = true }),
  callback = function(ev)
    if vim.bo[ev.buf].filetype == "kotlin" then
      update_kotlin_lsp_state(ev.buf)
    end
  end,
})

-- Update Kotlin LSP state when filetype is set to kotlin
vim.api.nvim_create_autocmd("FileType", {
  group = vim.api.nvim_create_augroup("LualineKotlinFileType", { clear = true }),
  pattern = "kotlin",
  callback = function(ev)
    -- Defer slightly to give LSP a chance to attach on first open
    vim.defer_fn(function()
      if vim.api.nvim_buf_is_valid(ev.buf) then
        update_kotlin_lsp_state(ev.buf)
        vim.cmd("redrawstatus")
      end
    end, 500)
  end,
})

-- Clean up cache when buffers are deleted (prevent memory leak)
vim.api.nvim_create_autocmd({ "BufDelete", "BufWipeout" }, {
  group = vim.api.nvim_create_augroup("LualineBufferCleanup", { clear = true }),
  callback = function(ev)
    _buf_state[ev.buf] = nil
  end,
})

return {
  {
    "nvim-lualine/lualine.nvim",
    optional = true,
    opts = function(_, opts)
      -- ==========================================
      -- GRADLE/ANDROID PROJECT INDICATOR
      -- ==========================================

      local function gradle_indicator()
        local bufnr = vim.api.nvim_get_current_buf()
        local state = _buf_state[bufnr]
        if not state or not state.is_gradle then
          return ""
        end

        if state.is_android then
          if state.sdk_configured then
            return "Android"
          else
            return "Android SDK missing"
          end
        end

        return "Gradle"
      end

      local function gradle_color()
        local bufnr = vim.api.nvim_get_current_buf()
        local state = _buf_state[bufnr]
        if state and state.is_android then
          if state.sdk_configured then
            return { fg = "#4CAF50" }
          else
            return { fg = "#FFC107" }
          end
        end
        return { fg = "#2196F3" }
      end

      -- ==========================================
      -- KOTLIN LSP INDICATOR
      -- ==========================================

      local function kotlin_lsp_indicator()
        local bufnr = vim.api.nvim_get_current_buf()
        local state = _buf_state[bufnr]
        if not state or not state.kotlin_lsp_active then
          return ""
        end

        if state.kotlin_lsp_active == "jb" then
          return "KLS:JB"
        end

        return "KLS:fwcd"
      end

      local function kotlin_lsp_color()
        local bufnr = vim.api.nvim_get_current_buf()
        local state = _buf_state[bufnr]
        if state and state.kotlin_lsp_active == "jb" then
          return { fg = "#4CAF50" }
        end
        return { fg = "#2196F3" }
      end

      local function has_kotlin_lsp()
        local bufnr = vim.api.nvim_get_current_buf()
        local state = _buf_state[bufnr]
        return state ~= nil and state.kotlin_lsp_active ~= nil
      end

      -- ==========================================
      -- REGISTER COMPONENTS
      -- ==========================================

      opts.sections = opts.sections or {}
      opts.sections.lualine_x = opts.sections.lualine_x or {}

      -- Gradle/Android indicator (shows for any Gradle project)
      table.insert(opts.sections.lualine_x, 1, {
        gradle_indicator,
        cond = function()
          local bufnr = vim.api.nvim_get_current_buf()
          local state = _buf_state[bufnr]
          return state ~= nil and state.is_gradle == true
        end,
        color = gradle_color,
      })

      -- Kotlin LSP indicator (shows which server is active)
      table.insert(opts.sections.lualine_x, 1, {
        kotlin_lsp_indicator,
        cond = has_kotlin_lsp,
        color = kotlin_lsp_color,
      })

      return opts
    end,
  },
}
