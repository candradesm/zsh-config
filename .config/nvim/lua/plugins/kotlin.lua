local use_jetbrains = vim.env.KOTLIN_LSP == "jetbrains"

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
-- Requires: brew install JetBrains/utils/kotlin-lsp
-- Official guide: https://github.com/Kotlin/kotlin-lsp/blob/main/scripts/neovim.md
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

  local function remove_stale_locks()
    local cache_dir = vim.fn.expand("~/Library/Caches/JetBrains/analyzer/workspaces")
    if vim.fn.isdirectory(cache_dir) == 0 or vim.fn.executable("lsof") == 0 then return end

    local locks = vim.fn.glob(cache_dir .. "/*/rocks/*/LOCK", false, true)
    for _, lock in ipairs(locks) do
      if vim.fn.filereadable(lock) == 1 and vim.trim(vim.fn.system({ "lsof", lock })) == "" then
        os.remove(lock)
      end
    end
  end

  local function cleanup_jetbrains_workspace()
    local nvim_pid = vim.fn.getpid()
    local cache_dir = vim.fn.expand("~/Library/Caches/JetBrains/analyzer/workspaces")
    local my_pids = {}
    local my_locks = {}

    if vim.fn.executable("pgrep") == 0 then return end

    local children = vim.trim(vim.fn.system({ "pgrep", "-P", tostring(nvim_pid) }))
    if children ~= "" then
      for _, pid in ipairs(vim.split(children, "\n")) do
        pid = vim.trim(pid)
        if pid ~= "" then
          local cmd = vim.trim(vim.fn.system({ "ps", "-o", "comm=", "-p", pid }))
          if cmd:find("intellij%-server") or cmd:find("java") then
            table.insert(my_pids, pid)
          end
        end
      end
    end

    if #my_pids > 0 and vim.fn.executable("lsof") == 1 then
      for _, pid in ipairs(my_pids) do
        local lsof_out = vim.fn.system({ "lsof", "-Fn", "-p", pid })
        for line in lsof_out:gmatch("[^\r\n]+") do
          local path = line:match("^n(.+)$")
          if path and path:match("LOCK$") and path:find(cache_dir, 1, true) then
            table.insert(my_locks, path)
          end
        end
      end
    end

    for _, pid in ipairs(my_pids) do
      vim.fn.system({ "kill", pid })
    end

    for _, path in ipairs(my_locks) do
      if vim.fn.filereadable(path) == 1 then os.remove(path) end
    end

    if vim.fn.isdirectory(cache_dir) == 1 and vim.fn.executable("lsof") == 1 then
      local workspaces = vim.fn.glob(cache_dir .. "/*", false, true)
      for _, ws in ipairs(workspaces) do
        local locks = vim.fn.glob(ws .. "/rocks/*/LOCK", false, true)
        for _, lock in ipairs(locks) do
          if vim.fn.filereadable(lock) == 1 and vim.trim(vim.fn.system({ "lsof", lock })) == "" then
            os.remove(lock)
          end
        end
      end
    end
  end

  table.insert(specs, {
    "LazyVim/LazyVim",
    init = function()
      remove_stale_locks()

      vim.lsp.config('kotlin_lsp', {
        cmd = { 'kotlin-lsp' },
        filetypes = { 'kotlin' },
        single_file_support = false,
        root_markers = { 'build.gradle', 'build.gradle.kts', 'pom.xml' },
      })
      vim.lsp.enable('kotlin_lsp')

      local group = vim.api.nvim_create_augroup("kotlin-lsp-cleanup", { clear = true })
      vim.api.nvim_create_autocmd("VimLeavePre", {
        group = group,
        callback = cleanup_jetbrains_workspace,
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
