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

  local function diagnose_jetbrains_workspace(phase)
    local cache_dir = vim.fn.expand("~/Library/Caches/JetBrains/analyzer/workspaces")
    local log_file = vim.fn.stdpath("log") .. "/kotlin-lsp-cleanup.log"
    local timestamp = os.date("%Y-%m-%d %H:%M:%S")
    local lines = {}
    local function add(msg)
      table.insert(lines, string.format("[%s] [%s] %s", timestamp, phase, msg))
    end

    add("Neovim PID: " .. vim.fn.getpid())

    -- 1. Cache directory
    if vim.fn.isdirectory(cache_dir) == 1 then
      local workspaces = vim.fn.glob(cache_dir .. "/*", false, true)
      add("Cache dir: " .. cache_dir .. " (" .. #workspaces .. " workspace(s))")

      -- 2. LOCK files
      if vim.fn.executable("lsof") == 1 then
        for _, ws in ipairs(workspaces) do
          local patterns = { ws .. "/LOCK", ws .. "/rocks/*/LOCK" }
          for _, pat in ipairs(patterns) do
            local locks = vim.fn.glob(pat, false, true)
            for _, lock in ipairs(locks) do
              local held = vim.fn.system({ "lsof", lock })
              if vim.trim(held) == "" then
                add("LOCK: " .. lock .. " → STALE (no holder)")
              else
                add("LOCK: " .. lock .. " → HELD\n" .. held)
              end
            end
          end
        end
      else
        add("lsof not available — skipping LOCK check")
      end
    else
      add("Cache dir not found: " .. cache_dir)
    end

    -- 3. intellij-server processes
    if vim.fn.executable("pgrep") == 1 then
      local ps_out = vim.trim(vim.fn.system({ "pgrep", "-f", "intellij-server" }))
      if ps_out == "" then
        add("intellij-server processes: none")
      else
        local pids = vim.split(ps_out, "\n")
        add("intellij-server processes: " .. #pids)
        for _, pid in ipairs(pids) do
          pid = vim.trim(pid)
          if pid ~= "" then
            local ppid_out = vim.trim(vim.fn.system({ "ps", "-o", "ppid=", "-p", pid }))
            local ppid = tonumber(ppid_out)
            local parent_cmd = ppid and vim.trim(vim.fn.system({ "ps", "-o", "comm=", "-p", ppid })) or "?"
            local is_orphan = ppid == 1
            local is_mine = ppid == vim.fn.getpid()
            add("  PID " .. pid .. " PPID " .. tostring(ppid or "?")
              .. " (" .. parent_cmd .. ") orphan=" .. tostring(is_orphan)
              .. " mine=" .. tostring(is_mine))
          end
        end
      end
    else
      add("pgrep not available — skipping process check")
    end

    local fd = io.open(log_file, "a")
    if fd then
      fd:write(table.concat(lines, "\n") .. "\n")
      fd:close()
    else
      vim.notify("kotlin-lsp-cleanup: could not write to " .. log_file, vim.log.levels.WARN)
    end
  end

  local function cleanup_jetbrains_workspace()
    local nvim_pid = vim.fn.getpid()
    local cache_dir = vim.fn.expand("~/Library/Caches/JetBrains/analyzer/workspaces")
    local my_server_pids = {}
    local my_lock_files = {}

    -- 1. Find intellij-server children of this Neovim
    if vim.fn.executable("pgrep") == 1 then
      local children = vim.trim(vim.fn.system({ "pgrep", "-P", tostring(nvim_pid) }))
      if children ~= "" then
        for _, pid in ipairs(vim.split(children, "\n")) do
          pid = vim.trim(pid)
          if pid ~= "" then
            local cmd = vim.trim(vim.fn.system({ "ps", "-o", "comm=", "-p", pid }))
            if cmd:find("intellij%-server") then
              table.insert(my_server_pids, pid)
            end
          end
        end
      end
    end

    -- 2. Find LOCK files held by our server PIDs (before killing)
    if #my_server_pids > 0 and vim.fn.executable("lsof") == 1 then
      for _, pid in ipairs(my_server_pids) do
        local lsof_out = vim.fn.system({ "lsof", "-Fn", "-p", pid })
        for line in lsof_out:gmatch("[^\r\n]+") do
          local path = line:match("^n(.+)$")
          if path and path:match("LOCK$") and path:find(cache_dir, 1, true) then
            table.insert(my_lock_files, path)
          end
        end
      end
    end

    -- 3. Kill our intellij-server processes
    for _, pid in ipairs(my_server_pids) do
      vim.fn.system({ "kill", pid })
    end

    -- 4. Remove identified LOCK files (now stale after kill)
    for _, path in ipairs(my_lock_files) do
      if vim.fn.filereadable(path) == 1 then
        os.remove(path)
      end
    end

    -- 5. Fallback: sweep for stale LOCKs (server may have died before VimLeavePre)
    if vim.fn.isdirectory(cache_dir) == 1 and vim.fn.executable("lsof") == 1 then
      local workspaces = vim.fn.glob(cache_dir .. "/*", false, true)
      for _, ws in ipairs(workspaces) do
        local locks = vim.fn.glob(ws .. "/rocks/*/LOCK", false, true)
        for _, lock in ipairs(locks) do
          if vim.trim(vim.fn.system({ "lsof", lock })) == "" then
            os.remove(lock)
            table.insert(my_lock_files, lock)
          end
        end
      end
    end

    if #my_server_pids > 0 or #my_lock_files > 0 then
      vim.notify(
        "Kotlin-LSP (JetBrains): killed " .. #my_server_pids .. " server(s), removed " .. #my_lock_files .. " LOCK file(s)",
        vim.log.levels.INFO
      )
    end
  end

  table.insert(specs, {
    "AlexandrosAlexiou/kotlin.nvim",
    ft = { "kotlin" },
    dependencies = {
      "stevearc/oil.nvim",
      "folke/trouble.nvim",
    },
    config = function()
      diagnose_jetbrains_workspace("STARTUP")

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

      local group = vim.api.nvim_create_augroup("kotlin-lsp-cleanup", { clear = true })
      vim.api.nvim_create_autocmd("VimLeavePre", {
        group = group,
        callback = function()
          diagnose_jetbrains_workspace("SHUTDOWN")
          cleanup_jetbrains_workspace()
        end,
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
