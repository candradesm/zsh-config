-- Android Development Configuration
-- Adds Android-specific enhancements on top of the Kotlin/Gradle setup.
-- Does NOT touch LSP classpath — kotlin-language-server handles its own Gradle sync.

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
      -- Mason-installed ktlint can hit the asdf/mise Java shim, which needs a .tool-versions entry.
      -- Force the real Java binary from JAVA_HOME so ktlint can run from any project.
      formatters = {
        ktlint = {
          env = {
            JAVA_HOME = os.getenv("JAVA_HOME") or "",
            PATH = (os.getenv("JAVA_HOME") or "") .. "/bin:" .. (os.getenv("PATH") or ""),
          },
        },
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
}
