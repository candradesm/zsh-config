-- Android Development Configuration for LazyVim
-- Supports: Kotlin, Java, XML (Android layouts), Markdown, Gradle
-- Features: LSP, auto-formatting, debugging
--
-- NOTE: Language extras are imported in lua/config/lazy.lua:
--   - lazyvim.plugins.extras.lang.kotlin
--   - lazyvim.plugins.extras.lang.java
--   - lazyvim.plugins.extras.lang.markdown
--   - lazyvim.plugins.extras.lang.toml

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
  -- ADDITIONAL MASON TOOLS FOR ANDROID DEV
  -- ==========================================
  {
    "mason-org/mason.nvim",
    opts = {
      ensure_installed = {
        -- Java formatting
        "google-java-format",
      },
    },
  },

  -- ==========================================
  -- FILETYPE DETECTION FOR GRADLE
  -- ==========================================
  {
    "LazyVim/LazyVim",
    init = function()
      -- Detect Groovy for .gradle files
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
    dependencies = {
      -- Ensure debug adapters are installed
      {
        "mason-org/mason.nvim",
        opts = {
          ensure_installed = {
            "kotlin-debug-adapter",
            "java-debug-adapter",
            "java-test",
          },
        },
      },
    },
  },

  -- ==========================================
  -- ANDROID PROJECT ROOT DETECTION
  -- ==========================================
  {
    "nvim-lspconfig",
    opts = {
      -- Ensure LSPs recognize Android project roots
      servers = {
        kotlin_language_server = {
          root_dir = function(fname)
            return require("lspconfig.util").root_pattern(
              "settings.gradle",
              "settings.gradle.kts",
              "build.gradle",
              "build.gradle.kts",
              "gradlew",
              ".git"
            )(fname)
          end,
        },
      },
    },
  },
}
