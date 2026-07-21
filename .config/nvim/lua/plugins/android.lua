-- Android Development Configuration
-- Adds Android-specific enhancements on top of the Kotlin/Gradle setup.
-- Does NOT touch LSP classpath — both kotlin-language-server and kotlin-lsp handle their own Gradle sync.

local gradle = require("utils.gradle")
local android = require("utils.android")

return {
  -- ==========================================
  -- AUTO-FORMAT ON SAVE
  -- ==========================================
  {
    "stevearc/conform.nvim",
    optional = true,
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
  },

  -- ==========================================
  -- GRADLE/GROOVY FILETYPE DETECTION
  -- ==========================================
  {
    "nvim-treesitter/nvim-treesitter",
    opts = function(_, opts)
      vim.list_extend(opts.ensure_installed, {
        "groovy",
      })
    end,
  },

  -- ==========================================
  -- FILETYPE DETECTION
  -- ==========================================
  {
    "LazyVim/LazyVim",
    init = function()
      vim.filetype.add({
        extension = {
          gradle = "groovy",
        },
        pattern = {
          [".*%.gradle%.kts"] = "kotlin",
        },
      })
    end,
  },

  -- ==========================================
  -- DEBUGGER ENHANCEMENTS
  -- ==========================================
  {
    "mfussenegger/nvim-dap",
    optional = true,
    config = function()
      local dap = require("dap")

      dap.configurations.kotlin = dap.configurations.kotlin or {}

      table.insert(dap.configurations.kotlin, {
        type = "kotlin",
        request = "attach",
        name = "Attach to Process",
        hostName = "localhost",
        port = 5005,
        options = {
          sourceMaps = true,
        },
      })
    end,
  },

  -- ==========================================
  -- STATUSLINE INDICATOR FOR GRADLE/ANDROID PROJECTS
  -- ==========================================
  {
    "nvim-lualine/lualine.nvim",
    optional = true,
    opts = function(_, opts)
      local function gradle_indicator()
        local project_root = gradle.find_project_root(vim.fn.expand("%:p"))
        if not project_root then
          return ""
        end

        if android.is_android_project(project_root) then
          local config = android.get_config()
          if config.is_sdk_configured then
            return "Android"
          else
            return "Android SDK missing"
          end
        end

        return "Gradle"
      end

      local function gradle_color()
        local project_root = gradle.find_project_root(vim.fn.expand("%:p"))
        if project_root and android.is_android_project(project_root) then
          local config = android.get_config()
          if config.is_sdk_configured then
            return { fg = "#4CAF50" }
          else
            return { fg = "#FFC107" }
          end
        end
        return { fg = "#2196F3" }
      end

      local function kotlin_lsp_indicator()
        if vim.bo.filetype ~= "kotlin" then
          return ""
        end
        local jetbrains = vim.env.KOTLIN_LSP == "jetbrains" or vim.g.kotlin_lsp == "jetbrains"
        return jetbrains and "Kotlin-LSP (JetBrains)" or "Kotlin-LSP"
      end

      local function kotlin_lsp_color()
        if vim.bo.filetype ~= "kotlin" then
          return {}
        end
        local jetbrains = vim.env.KOTLIN_LSP == "jetbrains" or vim.g.kotlin_lsp == "jetbrains"
        return jetbrains and { fg = "#BB86FC" } or { fg = "#2196F3" }
      end

      opts.sections = opts.sections or {}
      opts.sections.lualine_x = opts.sections.lualine_x or {}

      table.insert(opts.sections.lualine_x, 1, {
        kotlin_lsp_indicator,
        cond = function()
          return vim.bo.filetype == "kotlin"
        end,
        color = kotlin_lsp_color,
      })

      table.insert(opts.sections.lualine_x, 1, {
        gradle_indicator,
        cond = function()
          return gradle.is_gradle_project()
        end,
        color = gradle_color,
      })

      return opts
    end,
  },
}
