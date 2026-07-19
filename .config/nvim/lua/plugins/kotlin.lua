local use_jetbrains = vim.env.KOTLIN_LSP == "jetbrains"
  or vim.g.kotlin_lsp == "jetbrains"

local specs = {}

-- ==========================================
-- KOTLIN FILETYPE DETECTION
-- ==========================================
table.insert(specs, {
  "LazyVim/LazyVim",
  init = function()
    vim.filetype.add({
      extension = {
        kt = "kotlin",
        kts = "kotlin",
      },
    })
  end,
})

-- ==========================================
-- DEFAULT LSP: kotlin-language-server (fwcd)
-- ==========================================
if not use_jetbrains then
  table.insert(specs, {
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
                  target = vim.env.GRADLE_JVM_TARGET or "17",
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
  })
end

-- ==========================================
-- OPT-IN LSP: kotlin-lsp (JetBrains)
-- Enable with: KOTLIN_LSP=jetbrains or vim.g.kotlin_lsp = "jetbrains"
-- ==========================================
if use_jetbrains then
  table.insert(specs, {
    "neovim/nvim-lspconfig",
    opts = {
      servers = {
        kotlin_language_server = { enabled = false },
      },
    },
  })

  table.insert(specs, {
    "AlexandrosAlexiou/kotlin.nvim",
    ft = { "kotlin" },
    dependencies = {
      "stevearc/oil.nvim",
      "folke/trouble.nvim",
    },
    config = function()
      require("kotlin").setup({
        jvm_args = { "-Xmx4g" },
        inlay_hints = {
          enabled = true,
          parameters = true,
          types_property = true,
          types_variable = true,
          function_return = true,
        },
        folding = { enabled = true },
      })
    end,
  })
end



-- ==========================================
-- LSP ATTACH NOTIFICATION
-- ==========================================
table.insert(specs, {
  "LazyVim/LazyVim",
  init = function()
    vim.api.nvim_create_autocmd("LspAttach", {
      group = vim.api.nvim_create_augroup("kotlin-lsp-indicator", { clear = true }),
      callback = function(args)
        if vim.bo[args.buf].filetype ~= "kotlin" then
          return
        end
        local client = vim.lsp.get_client_by_id(args.data.client_id)
        if not client then
          return
        end
        local name = client.name
        local label = name == "kotlin-language-server" and "Kotlin-LSP (fwcd)"
          or (name == "kotlin-lsp" or name == "intellij-server") and "Kotlin-LSP (JetBrains)"
          or name
        vim.notify(label .. " attached", vim.log.levels.INFO, {
          title = "LSP",
          timeout = 2000,
        })
      end,
    })
  end,
})

-- ==========================================
-- GRADLE/ANDROID INITIALIZATION
-- ==========================================
table.insert(specs, {
  "LazyVim/LazyVim",
  init = function()
    vim.api.nvim_create_autocmd("User", {
      pattern = "VeryLazy",
      callback = function()
        require("utils.gradle").setup()
        require("utils.android").setup()
      end,
    })

    vim.keymap.set("n", "<leader>cl", "<cmd>checkhealth lsp<cr>", { desc = "Check LSP health" })
  end,
})

return specs
