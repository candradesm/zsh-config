-- Android Development Configuration
-- Adds Android-specific enhancements on top of the Kotlin/Gradle setup

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
  -- GRADLE/ANDROID INITIALIZATION
  -- ==========================================
  {
    "LazyVim/LazyVim",
    init = function()
      -- Initialize gradle and android modules on VeryLazy
      vim.api.nvim_create_autocmd("User", {
        pattern = "VeryLazy",
        callback = function()
          gradle.setup()
          android.setup()
        end,
      })
    end,
  },

  -- ==========================================
  -- ANDROID-SPECIFIC LSP ENHANCEMENTS
  -- ==========================================
  {
    "neovim/nvim-lspconfig",
    event = { "BufReadPre", "BufNewFile" },
    config = function()
      vim.api.nvim_create_autocmd("LspAttach", {
        group = vim.api.nvim_create_augroup("AndroidLspEnhancements", { clear = true }),
        callback = function(args)
          local client = vim.lsp.get_client_by_id(args.data.client_id)
          if not client or client.name ~= "kotlin_language_server" then
            return
          end

          local bufnr = args.buf
          local fname = vim.api.nvim_buf_get_name(bufnr)
          local buf_project_root = gradle.find_project_root(fname)

          if not buf_project_root then
            return
          end

          -- Only proceed if this is an Android project
          if not android.is_android_project(buf_project_root) then
            return
          end

          -- Add Android SDK jar to classpath
          local sdk_path = android.get_sdk_path()
          if not sdk_path then
            vim.notify("Android SDK not found. Android autocomplete may be limited.", vim.log.levels.WARN)
            return
          end

          local android_jar = android.find_android_jar(sdk_path)
          if not android_jar then
            vim.notify("android.jar not found in SDK", vim.log.levels.WARN)
            return
          end

          -- Get JVM target from project
          local jvm_target = gradle.get_jvm_target(buf_project_root)

          -- Update JVM target
          client:notify("workspace/didChangeConfiguration", {
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

          -- Get classpath with Android SDK included
          gradle.get_classpath_for_lsp(buf_project_root, { android_jar }, function(classpath)
            if classpath and client and client.is_attached then
              client:notify("workspace/didChangeConfiguration", {
                settings = {
                  kotlin = {
                    compiler = {
                      classpath = classpath,
                    },
                  },
                },
              })

              vim.notify("Android SDK configured for autocomplete", vim.log.levels.INFO)
            end
          end)
        end,
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

      -- Configure Kotlin debugger
      dap.configurations.kotlin = dap.configurations.kotlin or {}

      -- Add debug configuration
      table.insert(dap.configurations.kotlin, {
        type = "kotlin",
        request = "attach",
        name = "Attach to Process",
        hostName = "localhost",
        port =5005,
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
      -- Add Gradle/Android indicator to statusline
      local function gradle_indicator()
        local project_root = gradle.find_project_root(vim.fn.expand("%:p"))
        if not project_root then
          return ""
        end

        -- Check if Android project
        if android.is_android_project(project_root) then
          local config = android.get_config()
          if config.is_sdk_configured then
            return "Android"
          else
            return "⚠Android missing"
          end
        end

        -- Regular Gradle project
        return "Gradle"
      end

      local function gradle_color()
        local project_root = gradle.find_project_root(vim.fn.expand("%:p"))
        if project_root and android.is_android_project(project_root) then
          local config = android.get_config()
          if config.is_sdk_configured then
            return { fg = "#4CAF50" } -- Green when SDK is configured
          else
            return { fg = "#FFC107" } -- Yellow when SDK is not found
          end
        end
        -- Regular Gradle project - blue color
        return { fg = "#2196F3" }
      end

      -- Insert into the appropriate section
      opts.sections = opts.sections or {}
      opts.sections.lualine_x = opts.sections.lualine_x or {}

      -- Add indicator before other components
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