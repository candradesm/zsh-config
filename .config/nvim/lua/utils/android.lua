-- Android Development Utilities
-- Android-specific functionality that builds on top of gradle.lua

local M = {}

local gradle = require("utils.gradle")

-- ============================================================================
-- SDK DETECTION
-- ============================================================================

-- Common Android SDK installation paths to check
local COMMON_SDK_PATHS = {
  vim.fn.expand("~/Library/Android/sdk"),           -- macOS default
  vim.fn.expand("~/Android/Sdk"),                    -- Linux default
  "/usr/local/android-sdk",                          -- Manual install
  "/opt/android-sdk",                                -- Package manager
  vim.fn.expand("~/android-sdk"),                    -- Custom home
}

---Detect Android SDK path from environment or common locations
---@return string|nil sdk_path The detected SDK path or nil
---@return string source Description of where SDK was found
function M.detect_sdk_path()
  -- Priority 1: Check explicit environment variable
  local env_sdk = vim.env.ANDROID_SDK_ROOT or vim.env.ANDROID_HOME
  if env_sdk and vim.fn.isdirectory(env_sdk) == 1 then
    return env_sdk, "environment variable (ANDROID_SDK_ROOT/ANDROID_HOME)"
  end

  -- Priority 2: Auto-detect from common paths
  for _, path in ipairs(COMMON_SDK_PATHS) do
    if vim.fn.isdirectory(path) == 1 then
      -- Verify it looks like a valid Android SDK
      local platform_tools = path .. "/platform-tools"
      local platforms = path .. "/platforms"
      if vim.fn.isdirectory(platform_tools) == 1 or vim.fn.isdirectory(platforms) == 1 then
        return path, "auto-detected at " .. path
      end
    end
  end

  return nil, "not found"
end

---Get the Android SDK path with fallback to detection
---@return string|nil
function M.get_sdk_path()
  local sdk_path, source = M.detect_sdk_path()
  return sdk_path
end

---Check if Android SDK is properly configured
---@return boolean is_configured
---@return string|nil sdk_path
---@return string message
function M.check_sdk_configuration()
  local sdk_path, source = M.detect_sdk_path()

  if sdk_path then
    local has_env = vim.env.ANDROID_SDK_ROOT ~= nil or vim.env.ANDROID_HOME ~= nil
    if has_env then
      return true, sdk_path, "Android SDK found via " .. source
    else
      return true, sdk_path, "Android SDK auto-detected at: " .. sdk_path .. "\nConsider setting ANDROID_SDK_ROOT in your shell for consistency."
    end
  end

  return false, nil, M.get_setup_instructions()
end

---Get setup instructions for missing SDK
---@return string instructions
function M.get_setup_instructions()
  return [[
⚠️  Android SDK not found!

To enable Android autocomplete, please set up your Android SDK:

Option 1: Set environment variable (Recommended)
  export ANDROID_SDK_ROOT="/path/to/android/sdk"
  Add to your ~/.zshrc or ~/.bashrc

Option 2: Common SDK locations:
  macOS:   ~/Library/Android/sdk
  Linux:   ~/Android/Sdk

After setting up, restart Neovim.
]]
end

-- ============================================================================
-- PROJECT DETECTION
-- ============================================================================

---Check if current directory is an Android project
---@param filepath string|nil Optional file path to check (defaults to current buffer)
---@return boolean is_android_project
function M.is_android_project(filepath)
  local path = filepath or vim.fn.expand("%:p")
  if path == "" then
    path = vim.fn.getcwd()
  end

  -- Get project root
  local root = gradle.find_project_root(path)
  if not root then
    return false
  end

  -- Check for Android-specific indicators
  local indicators = {
    root .. "/AndroidManifest.xml",
    root .. "/app/src/main/AndroidManifest.xml",
    root .. "/app/build.gradle",
    root .. "/app/build.gradle.kts",
  }

  for _, indicator in ipairs(indicators) do
    if vim.fn.filereadable(indicator) == 1 or vim.fn.isdirectory(indicator) == 1 then
      return true
    end
  end

  -- Check if build.gradle references Android plugin
  local build_gradle = root .. "/build.gradle"
  local build_gradle_kts = root .. "/build.gradle.kts"

  for _, gradle_file in ipairs({ build_gradle, build_gradle_kts }) do
    if vim.fn.filereadable(gradle_file) == 1 then
      local content = vim.fn.readfile(gradle_file, "", 50)
      local content_str = table.concat(content, "\n")
      if content_str:match("com%.android%.tools%.build:gradle") or
         content_str:match("com%.android%.application") or
         content_str:match("android%(") then
        return true
      end
    end
  end

  return false
end

-- ============================================================================
-- JVM TARGET DETECTION (delegated to gradle module)
-- ============================================================================

---Auto-detect JVM target version from project gradle files
---@param project_root string|nil Optional project root path
---@return string|nil detected_version The detected JVM version or nil
function M.detect_jvm_target(project_root)
  -- Delegate to gradle module - works for all Gradle projects
  return gradle.detect_jvm_target(project_root)
end

---Get JVM target version
---Uses auto-detection first, then env var, then default
---@param project_root string|nil Optional project root path
---@return string jvm_target
function M.get_jvm_target(project_root)
  -- Delegate to gradle module - works for all Gradle projects
  return gradle.get_jvm_target(project_root)
end

-- ============================================================================
-- CONFIGURATION VALUES
-- ============================================================================

---Get cache directory
---@return string cache_dir
function M.get_cache_dir()
  return gradle.get_cache_dir()
end

---Check if caching is enabled
---@return boolean enabled
function M.is_cache_enabled()
  local cache_setting = vim.env.GRADLE_CACHE or vim.env.ANDROID_KLS_CACHE
  if cache_setting == nil then
    return true -- default to enabled
  end
  return cache_setting:lower() == "true" or cache_setting == "1"
end

---Get all Android-related configuration
---@return table config
function M.get_config()
  local sdk_path, source = M.detect_sdk_path()
  local project_root = gradle.find_project_root(vim.fn.expand("%:p"))

  return {
    sdk_path = sdk_path,
    sdk_source = source,
    is_sdk_configured = sdk_path ~= nil,
    jvm_target = M.get_jvm_target(project_root),
    jvm_target_auto_detected = M.detect_jvm_target(project_root) ~= nil,
    cache_enabled = M.is_cache_enabled(),
    cache_dir = M.get_cache_dir(),
    is_android_project = M.is_android_project(),
    is_gradle_project = gradle.is_gradle_project(),
    project_root = project_root,
  }
end

-- ============================================================================
-- USER FEEDBACK
-- ============================================================================

---Display configuration status
function M.show_status()
  local config = M.get_config()
  local lines = {
    "📱 Android/Gradle Development Configuration",
    "",
    "SDK Path:     " .. (config.sdk_path or "❌ Not found"),
    "SDK Source:   " .. config.sdk_source,
    "JVM Target:   " .. config.jvm_target,
    "Cache:        " .. (config.cache_enabled and "✅ Enabled" or "❌ Disabled"),
    "Cache Dir:    " .. config.cache_dir,
    "",
    "Gradle:       " .. (config.is_gradle_project and "✅ Gradle project detected" or "❌ Not a Gradle project"),
    "Android:      " .. (config.is_android_project and "✅ Android project detected" or "❌ Not an Android project"),
    "Project Root: " .. (config.project_root or "N/A"),
  }

  if not config.is_sdk_configured and config.is_android_project then
    table.insert(lines, "")
    table.insert(lines, M.get_setup_instructions())
  end

  vim.notify(table.concat(lines, "\n"), vim.log.levels.INFO)
end

---Setup notifications for SDK detection
function M.setup_notifications()
  local ok, sdk_path, message = M.check_sdk_configuration()

  if not ok then
    vim.notify(message, vim.log.levels.WARN, { title = "Android SDK" })
  elseif vim.env.ANDROID_SDK_ROOT == nil then
    -- SDK found but not via env var - give helpful hint
    vim.schedule(function()
      vim.notify(message, vim.log.levels.INFO, { title = "Android SDK (Auto-detected)" })
    end)
  end
end

-- ============================================================================
-- INITIALIZATION
-- ============================================================================

function M.setup()
  -- Ensure cache directory exists
  local cache_dir = M.get_cache_dir()
  vim.fn.mkdir(cache_dir, "p")

  -- Check SDK configuration on startup (only if in Android project)
  vim.api.nvim_create_autocmd("FileType", {
    pattern = { "kotlin", "java", "groovy" },
    callback = function()
      if M.is_android_project() then
        M.setup_notifications()
      end
    end,
    once = true,
  })

  -- Create user command to show status
  vim.api.nvim_create_user_command("AndroidInfo", M.show_status, {
    desc = "Show Android development configuration status",
  })
end

return M
