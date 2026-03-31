-- Kotlin Language Server Configuration
-- FIX: Register LSP config directly for Neovim 0.11+

local gradle = require("utils.gradle")

-- Register the LSP config directly
vim.lsp.config["kotlin_language_server"] = {
  cmd = { "kotlin-language-server" },
  filetypes = { "kotlin" },
  root_markers = { "settings.gradle", "settings.gradle.kts", "build.gradle", "build.gradle.kts", "pom.xml", ".git" },
  init_options = {
    -- CRITICAL: Use cache dir instead of vim.fs.root() which can return nil
    -- See: https://github.com/neovim/nvim-lspconfig/issues/3239
    storagePath = vim.fn.resolve(vim.fn.stdpath("cache") .. "/kotlin_language_server"),
  },
  settings = {
    kotlin = {
      compiler = {
        jvm = {
          target = "17",
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
}

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
  -- KOTLIN LANGUAGE SERVER
  -- ==========================================
  {
    "neovim/nvim-lspconfig",
    optional = true,  -- Don't conflict with LazyVim's LSP setup
    init = function()
      -- Auto-start LSP when opening Kotlin files
      vim.api.nvim_create_autocmd("FileType", {
        pattern = "kotlin",
        callback = function()
          -- Defer to ensure buffer is fully loaded
          vim.defer_fn(function()
            local bufname = vim.api.nvim_buf_get_name(0)
            if bufname == "" then
              return -- Skip if no filename yet
            end

            -- Find project root
            local root_dir = gradle.find_project_root(bufname)
            if not root_dir then
              root_dir = vim.fs.root(bufname, {
                "settings.gradle", "settings.gradle.kts",
                "build.gradle", "build.gradle.kts",
                "pom.xml", ".git"
              })
            end
            if not root_dir then
              root_dir = vim.fn.getcwd()
            end

            -- Check if client already exists for this root
            local clients = vim.lsp.get_clients({ name = "kotlin_language_server", bufnr = 0 })
            if #clients > 0 then
              return -- Already attached
            end

            -- Get JVM target from env or detect from project
            local jvm_target = os.getenv("GRADLE_JVM_TARGET")
              or os.getenv("ANDROID_KLS_JVM_TARGET")
              or gradle.get_jvm_target(root_dir)
              or "17"

-- Start LSP with full config
             local client_id = vim.lsp.start({
               name = "kotlin_language_server",
               cmd = { "kotlin-language-server" },
               root_dir = root_dir,
               filetypes = { "kotlin" },
               init_options = {
                 storagePath = vim.fn.resolve(vim.fn.stdpath("cache") .. "/kotlin_language_server"),
               },
               settings = {
                 kotlin = {
                   compiler = {
                     jvm = {
                       target = jvm_target,
                     },
                   },
                 },
               },
             })

             -- Send classpath immediately after LSP starts
             if client_id then
               vim.defer_fn(function()
                 gradle.send_classpath_to_lsp(root_dir)
               end, 500)
             end
          end, 100)
        end,
      })

      -- Initialize gradle and android modules on VeryLazy
      vim.api.nvim_create_autocmd("User", {
        pattern = "VeryLazy",
        callback = function()
          gradle.setup()
          require("utils.android").setup()
        end,
      })
    end,
  },
}