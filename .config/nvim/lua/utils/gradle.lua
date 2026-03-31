-- Gradle Integration Utilities
-- Provides project detection, module detection, JVM target detection,
-- and manual Gradle commands. Does NOT inject classpath into LSP —
-- kotlin-language-server handles its own Gradle sync internally.

local M = {}

-- ============================================================================
-- CONFIGURATION
-- ============================================================================

local GRADLE_TIMEOUT = tonumber(vim.env.GRADLE_TIMEOUT) or 120000
local GRADLE_FEEDBACK_LEVEL = vim.env.GRADLE_FEEDBACK or "medium"

local TIMEOUTS = {
  DEFAULT = GRADLE_TIMEOUT,
  DISCOVERY = 60000,
  FAST_PATH = 30000,
}

local FAST_PATH_CONFIGS = {
  "debugCompileClasspath",
  "releaseCompileClasspath",
  "compileClasspath",
  "implementation",
  "runtimeClasspath",
}

local GRADLE_CACHE_PATHS = {
  vim.fn.expand("~/.gradle/caches/modules-2/files-2.1"),
  vim.fn.expand("~/.gradle/caches/build-cache-1"),
}

local DEFAULT_CACHE_DIR = vim.fn.expand("~/.cache/nvim/gradle")

-- ============================================================================
-- UTILITY FUNCTIONS
-- ============================================================================

local function log(message, level, notify_level)
  notify_level = notify_level or vim.log.levels.INFO
  local levels = { minimal = 1, medium = 2, verbose = 3 }
  local msg_level = levels[level] or 2
  local cfg_level = levels[GRADLE_FEEDBACK_LEVEL] or 2

  if msg_level > cfg_level then
    return
  end

  vim.notify(message, notify_level)
end

function M.get_cache_dir()
  local custom_cache = vim.env.GRADLE_CACHE_DIR or vim.env.NVIM_ANDROID_CACHE_DIR
  if custom_cache then
    return vim.fn.expand(custom_cache)
  end
  return DEFAULT_CACHE_DIR
end

-- ============================================================================
-- PROJECT DETECTION
-- ============================================================================

function M.find_project_root(filepath)
  local path = vim.fn.fnamemodify(filepath, ":p:h")

  while path and path ~= "/" and path ~= "" do
    local settings_gradle = path .. "/settings.gradle"
    local settings_gradle_kts = path .. "/settings.gradle.kts"
    local build_gradle = path .. "/build.gradle"
    local build_gradle_kts = path .. "/build.gradle.kts"
    local gradlew = path .. "/gradlew"

    if vim.fn.filereadable(settings_gradle) == 1 or
       vim.fn.filereadable(settings_gradle_kts) == 1 or
       vim.fn.filereadable(gradlew) == 1 then
      return path
    end

    if vim.fn.filereadable(build_gradle) == 1 or
       vim.fn.filereadable(build_gradle_kts) == 1 then
      local parent = vim.fn.fnamemodify(path, ":h")
      if parent ~= path then
        if vim.fn.filereadable(parent .. "/settings.gradle") == 1 or
           vim.fn.filereadable(parent .. "/settings.gradle.kts") == 1 then
          return parent
        end
      end
      return path
    end

    path = vim.fn.fnamemodify(path, ":h")
  end

  return nil
end

function M.is_gradle_project(filepath)
  local path = filepath or vim.fn.expand("%:p")
  if path == "" then
    path = vim.fn.getcwd()
  end

  local root = M.find_project_root(path)
  if not root then
    return false
  end

  local indicators = {
    root .. "/build.gradle",
    root .. "/build.gradle.kts",
    root .. "/settings.gradle",
    root .. "/settings.gradle.kts",
    root .. "/gradlew",
  }

  for _, indicator in ipairs(indicators) do
    if vim.fn.filereadable(indicator) == 1 then
      return true
    end
  end

  return false
end

function M.detect_modules(project_root)
  local modules = {}

  if vim.fn.isdirectory(project_root .. "/app") == 1 then
    table.insert(modules, "app:")
  end

  local dirs = vim.fn.glob(project_root .. "/*", false, true)
  for _, dir in ipairs(dirs) do
    if vim.fn.isdirectory(dir) == 1 then
      local name = vim.fn.fnamemodify(dir, ":t")
      if name ~= ".git" and name ~= ".idea" and name ~= "build" and
         name ~= ".gradle" and name ~= "gradle" and name ~= "app" then
        if vim.fn.filereadable(dir .. "/build.gradle") == 1 or
           vim.fn.filereadable(dir .. "/build.gradle.kts") == 1 then
          table.insert(modules, name .. ":")
        end
      end
    end
  end

  return modules
end

-- ============================================================================
-- CACHE MANAGEMENT
-- ============================================================================

function M.get_cache_file(project_root)
  local cache_dir = M.get_cache_dir()
  vim.fn.mkdir(cache_dir, "p")
  local safe_name = project_root:gsub("/", "_"):gsub(":", "_")
  return cache_dir .. "/classpath_" .. safe_name .. ".json"
end

function M.load_cached_classpath(project_root)
  local cache_file = M.get_cache_file(project_root)

  if vim.fn.filereadable(cache_file) ~= 1 then
    return nil
  end

  local ok, content = pcall(vim.fn.readfile, cache_file)
  if not ok or #content == 0 then
    return nil
  end

  local ok2, data = pcall(vim.json.decode, table.concat(content, "\n"))
  if not ok2 then
    log("Failed to parse cached classpath", "verbose", vim.log.levels.WARN)
    return nil
  end

  local build_gradle = project_root .. "/build.gradle"
  local build_gradle_kts = project_root .. "/build.gradle.kts"
  local gradle_file = vim.fn.filereadable(build_gradle) == 1 and build_gradle or build_gradle_kts

  if gradle_file and vim.fn.filereadable(gradle_file) == 1 then
    local gradle_mtime = vim.fn.getftime(gradle_file)
    if data.gradle_mtime and data.gradle_mtime < gradle_mtime then
      log("Classpath cache is outdated, resyncing...", "medium")
      return nil
    end
  end

  return data
end

function M.save_cached_classpath(project_root, classpath_data)
  local cache_file = M.get_cache_file(project_root)

  classpath_data.timestamp = os.time()
  local gradle_file = project_root .. "/build.gradle"
  local gradle_kts = project_root .. "/build.gradle.kts"
  if vim.fn.filereadable(gradle_file) == 1 then
    classpath_data.gradle_mtime = vim.fn.getftime(gradle_file)
  elseif vim.fn.filereadable(gradle_kts) == 1 then
    classpath_data.gradle_mtime = vim.fn.getftime(gradle_kts)
  end

  local ok, encoded = pcall(vim.json.encode, classpath_data)
  if ok then
    local f = io.open(cache_file, "w")
    if f then
      f:write(encoded)
      f:close()
    end
  end
end

function M.get_cached_gradle_config(project_root)
  local cache_file = M.get_cache_file(project_root):gsub("classpath_", "gradle_config_")

  if vim.fn.filereadable(cache_file) ~= 1 then
    return nil
  end

  local ok, content = pcall(vim.fn.readfile, cache_file)
  if not ok then
    return nil
  end

  local ok2, data = pcall(vim.json.decode, table.concat(content, "\n"))
  if ok2 and data.module and data.configuration then
    return data
  end

  return nil
end

function M.save_gradle_config(project_root, module, configuration)
  local cache_file = M.get_cache_file(project_root):gsub("classpath_", "gradle_config_")

  local data = {
    module = module,
    configuration = configuration,
    timestamp = os.time(),
  }

  local ok, encoded = pcall(vim.json.encode, data)
  if ok then
    local f = io.open(cache_file, "w")
    if f then
      f:write(encoded)
      f:close()
    end
  end
end

function M.clear_cache()
  local cache_dir = M.get_cache_dir()
  local files = vim.fn.glob(cache_dir .. "/*.json", false, true)
  for _, file in ipairs(files) do
    vim.fn.delete(file)
  end
  log("Gradle classpath cache cleared", "minimal")
end

-- ============================================================================
-- JVM TARGET DETECTION
-- ============================================================================

function M.detect_jvm_target(project_root)
  local root = project_root or M.find_project_root(vim.fn.expand("%:p"))
  if not root then
    return nil
  end

  local files_to_check = {
    root .. "/app/build.gradle.kts",
    root .. "/app/build.gradle",
    root .. "/build.gradle.kts",
    root .. "/build.gradle",
    root .. "/gradle.properties",
  }

  for _, filepath in ipairs(files_to_check) do
    if vim.fn.filereadable(filepath) == 1 then
      local content = table.concat(vim.fn.readfile(filepath, "", 100), "\n")

      local toolchain = content:match("jvmToolchain%((%d+)%)") or
                        content:match("jvmToolchain%s*=%s*(%d+)")
      if toolchain then
        return toolchain
      end

      local java_version = content:match("JavaVersion%.VERSION_(%d+)")
      if java_version then
        return java_version
      end

      local source_compat = content:match("sourceCompatibility%s*=%s*JavaVersion%.VERSION_(%d+)")
      if source_compat then
        return source_compat
      end

      local target_compat = content:match("targetCompatibility%s*=%s*JavaVersion%.VERSION_(%d+)")
      if target_compat then
        return target_compat
      end

      if filepath:match("gradle%.properties$") then
        local kotlin_target = content:match("kotlin%.jvm%.target%s*=%s*(%d+)")
        if kotlin_target then
          return kotlin_target
        end
      end
    end
  end

  return nil
end

function M.get_jvm_target(project_root)
  local detected = M.detect_jvm_target(project_root)
  if detected then
    return detected
  end

  return vim.env.GRADLE_JVM_TARGET or vim.env.ANDROID_KLS_JVM_TARGET or "17"
end

-- ============================================================================
-- GRADLE CLASSPATH EXTRACTION (for manual use, NOT for LSP injection)
-- ============================================================================

function M.try_gradle_config(project_root, module, configuration, timeout, extra_classpath, callback)
  local gradlew = project_root .. "/gradlew"
  local cmd = {
    gradlew,
    module .. "dependencies",
    "--configuration", configuration,
    "--quiet"
  }

  log("Trying: " .. module .. configuration, "verbose")

  vim.system(cmd, {
    cwd = project_root,
    timeout = timeout,
  }, function(result)
    if result.code == 0 then
      local output = result.stdout or ""
      local classpath = M.parse_dependencies_output(output, project_root, extra_classpath)

      if #classpath > 0 then
        vim.schedule(function()
          log("Found " .. #classpath .. " deps in " .. module .. configuration, "verbose")
          callback(true, classpath)
        end)
      else
        vim.schedule(function()
          callback(false, nil)
        end)
      end
    else
      vim.schedule(function()
        callback(false, nil)
      end)
    end
  end)
end

function M.extract_classpath_async(project_root, extra_classpath, callback)
  local gradlew = project_root .. "/gradlew"

  if vim.fn.filereadable(gradlew) ~= 1 then
    callback(nil, "No gradlew found in project root: " .. project_root)
    return
  end

  log("Syncing gradle dependencies...", "minimal")

  local cached = M.get_cached_gradle_config(project_root)
  if cached then
    log("Using cached config: " .. cached.module .. cached.configuration, "verbose")
    M.try_gradle_config(project_root, cached.module, cached.configuration, TIMEOUTS.DISCOVERY, extra_classpath, function(success, classpath)
      if success then
        M.save_cached_classpath(project_root, { classpath = classpath })
        callback(classpath, nil)
        return
      end
      M.run_fast_path(project_root, extra_classpath, callback)
    end)
    return
  end

  M.run_fast_path(project_root, extra_classpath, callback)
end

function M.run_fast_path(project_root, extra_classpath, callback)
  local modules = M.detect_modules(project_root)
  if #modules == 0 then
    table.insert(modules, "")
  end

  local all_classpaths = {}
  local attempted = 0
  local total_attempts = #modules * #FAST_PATH_CONFIGS
  local success_found = false

  log("Phase 1: Fast path detection...", "medium")

  for _, module in ipairs(modules) do
    for _, config in ipairs(FAST_PATH_CONFIGS) do
      M.try_gradle_config(project_root, module, config, TIMEOUTS.FAST_PATH, extra_classpath, function(success, classpath)
        vim.schedule(function()
          attempted = attempted + 1

          if success and classpath then
            for _, jar in ipairs(classpath) do
              table.insert(all_classpaths, jar)
            end

            if not success_found then
              success_found = true
              M.save_gradle_config(project_root, module, config)
            end
          end

          if attempted >= total_attempts then
            if #all_classpaths > 0 then
              local seen = {}
              local unique = {}
              for _, jar in ipairs(all_classpaths) do
                if not seen[jar] then
                  seen[jar] = true
                  table.insert(unique, jar)
                end
              end

              M.save_cached_classpath(project_root, { classpath = unique })
              log("Found " .. #unique .. " unique dependencies", "minimal")
              callback(unique, nil)
            else
              log("Phase 2: Deep discovery...", "medium")
              M.run_deep_discovery(project_root, extra_classpath, callback)
            end
          end
        end)
      end)
    end
  end
end

function M.list_all_configurations(project_root, callback)
  local gradlew = project_root .. "/gradlew"
  local modules = M.detect_modules(project_root)
  if #modules == 0 then
    table.insert(modules, "")
  end

  local all_configs = {}
  local pending = #modules

  for _, module in ipairs(modules) do
    local cmd = { gradlew, module .. "dependencies", "--quiet" }

    vim.system(cmd, {
      cwd = project_root,
      timeout = TIMEOUTS.FAST_PATH,
    }, function(result)
      pending = pending - 1

      if result.code == 0 then
        local output = result.stdout or ""
        for line in output:gmatch("[^\r\n]+") do
          local config = line:match("^(%w+[%w]*) %- ")
          if config and not all_configs[config] then
            all_configs[config] = module
          end
        end
      end

      if pending == 0 then
        vim.schedule(function()
          local config_list = {}
          for config, mod in pairs(all_configs) do
            table.insert(config_list, { config = config, module = mod })
          end
          callback(config_list)
        end)
      end
    end)
  end
end

function M.run_deep_discovery(project_root, extra_classpath, callback)
  M.list_all_configurations(project_root, function(configs)
    if not configs or #configs == 0 then
      callback(nil, "No gradle configurations found")
      return
    end

    log("Found " .. #configs .. " configurations, trying each...", "verbose")

    local all_classpaths = {}
    local pending = #configs

    for _, config_info in ipairs(configs) do
      M.try_gradle_config(project_root, config_info.module, config_info.config, TIMEOUTS.DISCOVERY, extra_classpath, function(success, classpath)
        pending = pending - 1

        if success and classpath then
          for _, jar in ipairs(classpath) do
            table.insert(all_classpaths, jar)
          end
        end

        if pending == 0 then
          vim.schedule(function()
            if #all_classpaths > 0 then
              local seen = {}
              local unique = {}
              for _, jar in ipairs(all_classpaths) do
                if not seen[jar] then
                  seen[jar] = true
                  table.insert(unique, jar)
                end
              end

              M.save_cached_classpath(project_root, { classpath = unique })
              log("Found " .. #unique .. " unique dependencies (deep)", "minimal")
              callback(unique, nil)
            else
              callback(nil, "Could not extract dependencies from any configuration")
            end
          end)
        end
      end)
    end
  end)
end

-- ============================================================================
-- PARSE DEPENDENCIES
-- ============================================================================

function M.parse_dependencies_output(output, project_root, extra_classpath)
  local entries = {}
  local seen = {}

  if extra_classpath then
    for _, path in ipairs(extra_classpath) do
      table.insert(entries, path)
      seen[path] = true
    end
  end

  for line in output:gmatch("[^\r\n]+") do
    local group, artifact, version

    group, artifact, version = line:match("^[%s|]*%+%-%-%-%s+([^:]+):([^:]+):([^%s]+)")

    if not version then
      group, artifact, version = line:match("^[%s|]*%+%-%-%-%s+([^:]+):([^:]+)%s*%-%>%s*([^%s]+)")
    end

    if group and artifact and version then
      version = version:gsub("%s*%([%a*]+%)$", "")

      local jar_path = M.find_gradle_cached_jar(group, artifact, version)
      if jar_path and not seen[jar_path] then
        table.insert(entries, jar_path)
        seen[jar_path] = true
      end
    end
  end

  local local_jars = M.find_local_project_jars(project_root)
  for _, jar in ipairs(local_jars) do
    if not seen[jar] then
      table.insert(entries, jar)
      seen[jar] = true
    end
  end

  return entries
end

function M.find_gradle_cached_jar(group, artifact, version)
  local artifacts_to_try = { artifact, artifact .. "-jvm", artifact .. "-android" }

  for _, gradle_cache in ipairs(GRADLE_CACHE_PATHS) do
    for _, artifact_name in ipairs(artifacts_to_try) do
      local artifact_dir = gradle_cache .. "/" .. group .. "/" .. artifact_name .. "/" .. version

      local fd = vim.uv.fs_scandir(artifact_dir)
      if fd then
        local jars = {}
        while true do
          local name, type = vim.uv.fs_scandir_next(fd)
          if not name then break end
          if type == "directory" then
            local subdir = artifact_dir .. "/" .. name
            local subfd = vim.uv.fs_scandir(subdir)
            if subfd then
              while true do
                local subname, subtype = vim.uv.fs_scandir_next(subfd)
                if not subname then break end
                if subtype == "file" and subname:match("%.jar$") then
                  table.insert(jars, subdir .. "/" .. subname)
                end
              end
            end
          end
        end

        if #jars > 0 then
          local main_jars = {}
          for _, jar in ipairs(jars) do
            if not jar:match("%-sources%.jar$") and not jar:match("%-javadoc%.jar$") then
              table.insert(main_jars, jar)
            end
          end

          if #main_jars > 0 then
            local main_jar_pattern = artifact_name .. "%-" .. version .. "%.jar$"
            for _, jar in ipairs(main_jars) do
              if jar:match(main_jar_pattern) then
                return jar
              end
            end
            return main_jars[1]
          end
        end
      end
    end
  end

  return nil
end

function M.find_local_project_jars(project_root)
  local jars = {}

  local build_dirs = {
    project_root .. "/app/build/intermediates/javac/debug/classes",
    project_root .. "/app/build/intermediates/javac/release/classes",
    project_root .. "/app/build/tmp/kotlin-classes/debug",
    project_root .. "/app/build/tmp/kotlin-classes/release",
    project_root .. "/build/intermediates/javac/debug/classes",
    project_root .. "/build/classes/java/main",
    project_root .. "/build/classes/kotlin/main",
  }

  for _, dir in ipairs(build_dirs) do
    if vim.fn.isdirectory(dir) == 1 then
      table.insert(jars, dir)
    end
  end

  return jars
end

-- ============================================================================
-- SYNC MANAGEMENT (for manual commands, NOT for LSP injection)
-- ============================================================================

M._sync_in_progress = {}

function M.sync_project(project_root, extra_classpath, callback)
  if M._sync_in_progress[project_root] then
    log("Gradle sync already in progress...", "medium", vim.log.levels.WARN)
    return
  end

  M._sync_in_progress[project_root] = true

  local cached = M.load_cached_classpath(project_root)
  if cached and cached.classpath then
    M._sync_in_progress[project_root] = nil
    log("Using cached classpath", "verbose")
    local seen = {}
    local merged = {}
    for _, path in ipairs(cached.classpath) do
      if not seen[path] then
        seen[path] = true
        table.insert(merged, path)
      end
    end
    if extra_classpath then
      for _, path in ipairs(extra_classpath) do
        if not seen[path] then
          seen[path] = true
          table.insert(merged, path)
        end
      end
    end
    callback(true, merged, nil)
    return
  end

  M.extract_classpath_async(project_root, extra_classpath, function(classpath, error)
    M._sync_in_progress[project_root] = nil

    if error then
      callback(false, nil, error)
      return
    end

    M.save_cached_classpath(project_root, {
      classpath = classpath,
      project_root = project_root,
    })

    callback(true, classpath, nil)
  end)
end

function M.force_sync(project_root, extra_classpath, callback)
  local cache_file = M.get_cache_file(project_root)
  if vim.fn.filereadable(cache_file) == 1 then
    vim.fn.delete(cache_file)
  end
  local config_cache = cache_file:gsub("classpath_", "gradle_config_")
  if vim.fn.filereadable(config_cache) == 1 then
    vim.fn.delete(config_cache)
  end

  M.sync_project(project_root, extra_classpath, callback)
end

-- ============================================================================
-- COMMANDS AND KEYMAPS
-- ============================================================================

function M.setup()
  vim.api.nvim_create_user_command("GradleSync", function()
    local project_root = M.find_project_root(vim.fn.expand("%:p")) or vim.fn.getcwd()
    M.sync_project(project_root, nil, function(success, classpath, error)
      if success then
        log("Gradle sync complete! " .. #classpath .. " dependencies cached", "minimal")
      else
        log("Gradle sync failed: " .. (error or "unknown error"), "minimal", vim.log.levels.ERROR)
      end
    end)
  end, { desc = "Sync gradle dependencies for current project" })

  vim.api.nvim_create_user_command("GradleSyncForce", function()
    local project_root = M.find_project_root(vim.fn.expand("%:p")) or vim.fn.getcwd()
    M.force_sync(project_root, nil, function(success, classpath, error)
      if success then
        log("Gradle force sync complete! " .. #classpath .. " dependencies cached", "minimal")
      else
        log("Gradle sync failed: " .. (error or "unknown error"), "minimal", vim.log.levels.ERROR)
      end
    end)
  end, { desc = "Force sync gradle dependencies (ignore cache)" })

  vim.api.nvim_create_user_command("GradleClearCache", M.clear_cache, {
    desc = "Clear all cached gradle classpaths",
  })

  vim.api.nvim_create_autocmd("FileType", {
    pattern = { "kotlin", "java", "groovy" },
    callback = function()
      local project_root = M.find_project_root(vim.fn.expand("%:p"))
      if not project_root then
        return
      end

      local has_gradle = vim.fn.filereadable(project_root .. "/build.gradle") == 1 or
                         vim.fn.filereadable(project_root .. "/build.gradle.kts") == 1 or
                         vim.fn.filereadable(project_root .. "/settings.gradle") == 1 or
                         vim.fn.filereadable(project_root .. "/settings.gradle.kts") == 1 or
                         vim.fn.filereadable(project_root .. "/gradlew") == 1
      if has_gradle then
        vim.keymap.set("n", "<leader>Gs", "<cmd>GradleSync<cr>",
          { buffer = true, desc = "Gradle Sync" })
        vim.keymap.set("n", "<leader>Gf", "<cmd>GradleSyncForce<cr>",
          { buffer = true, desc = "Gradle Sync (Force)" })
        vim.keymap.set("n", "<leader>Gc", "<cmd>GradleClearCache<cr>",
          { buffer = true, desc = "Clear Gradle Cache" })
      end
    end,
  })

  vim.api.nvim_create_autocmd("BufWritePost", {
    pattern = { "*.gradle", "*.gradle.kts" },
    callback = function()
      local project_root = M.find_project_root(vim.fn.expand("%:p"))
      if not project_root then
        return
      end

      local has_gradle = vim.fn.filereadable(project_root .. "/build.gradle") == 1 or
                         vim.fn.filereadable(project_root .. "/build.gradle.kts") == 1 or
                         vim.fn.filereadable(project_root .. "/settings.gradle") == 1 or
                         vim.fn.filereadable(project_root .. "/settings.gradle.kts") == 1 or
                         vim.fn.filereadable(project_root .. "/gradlew") == 1

      if has_gradle and vim.env.GRADLE_AUTO_SYNC == "true" then
        vim.defer_fn(function()
          M.force_sync(project_root, nil, function(success)
            if success then
              log("Auto-synced gradle dependencies", "verbose")
            end
          end)
        end, 1000)
      end
    end,
  })
end

return M
