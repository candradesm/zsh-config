-- Kotlin Language Server Configuration
-- Works WITH LazyVim's kotlin extra, not against it.
-- kotlin-language-server handles its own Gradle sync internally.

return {
  -- ==========================================
  -- KOTLIN FILETYPE DETECTION
  -- ==========================================
  {
    "LazyVim/LazyVim",
    init = function()
      vim.filetype.add({
        extension = {
          kt = "kotlin",
          kts = "kotlin",
        },
      })
    end,
  },

  -- ==========================================
  -- KOTLIN LANGUAGE SERVER CONFIGURATION
  -- ==========================================
  -- Extends LazyVim's kotlin extra via lspconfig opts.
  -- Do NOT manually start the LSP — LazyVim handles that.
  {
    "neovim/nvim-lspconfig",
    opts = {
      servers = {
        kotlin_language_server = {
          init_options = {
            storagePath = vim.fn.resolve(vim.fn.stdpath("cache") .. "/kotlin_language_server"),
          },
          settings = {
            kotlin = {
              compiler = {
                jvm = {
                  target = vim.env.GRADLE_JVM_TARGET or vim.env.ANDROID_KLS_JVM_TARGET or "17",
                },
              },
              linting = {
                debounceTime = 300,
              },
              indexing = {
                enabled = true,
              },
              externalSources = {
                autoConvertToKotlin = true,
              },
            },
          },
        },
      },
    },
  },

  -- ==========================================
  -- GRADLE/ANDROID INITIALIZATION
  -- ==========================================
  {
    "LazyVim/LazyVim",
    init = function()
      vim.api.nvim_create_autocmd("User", {
        pattern = "VeryLazy",
        callback = function()
          require("utils.gradle").setup()
          require("utils.android").setup()
        end,
      })

      vim.keymap.set("n", "<leader>cl", "<cmd>checkhealth lsp<cr>",
        { desc = "Check LSP health" })
    end,
  },
}
