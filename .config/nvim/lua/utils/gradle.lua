-- Gradle Integration Utilities
-- Provides project detection, module detection, and JVM target detection.
-- Does NOT handle classpath injection — kotlin-language-server manages its own Gradle sync.

local M = {}

-- ============================================================================
-- CONFIGURATION
-- ============================================================================

local DEFAULT_CACHE_DIR = vim.fn.expand("~/.cache/nvim/gradle")

-- ============================================================================
-- UTILITY FUNCTIONS
-- ============================================================================

function M.get_cache_dir()
  local custom_cache = vim.env.GRADLE_CACHE_DIR
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

  return vim.env.GRADLE_JVM_TARGET or "17"
end

-- ============================================================================
-- INITIALIZATION
-- ============================================================================

function M.setup()
  -- No commands or keymaps to register.
  -- kotlin-language-server handles its own Gradle sync internally.
end

return M
