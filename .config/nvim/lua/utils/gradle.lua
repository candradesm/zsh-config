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
  local candidate = nil

  while path and path ~= "/" and path ~= "" do
    if vim.fn.filereadable(path .. "/settings.gradle") == 1 or
       vim.fn.filereadable(path .. "/settings.gradle.kts") == 1 or
       vim.fn.filereadable(path .. "/gradlew") == 1 then
      return path
    end

    -- In multi-module projects, build.gradle files can live several levels below the real root.
    if not candidate then
      if vim.fn.filereadable(path .. "/build.gradle") == 1 or
         vim.fn.filereadable(path .. "/build.gradle.kts") == 1 then
        candidate = path
      end
    end

    path = vim.fn.fnamemodify(path, ":h")
  end

  return candidate
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
-- KOTLIN VERSION DETECTION
-- ============================================================================

function M.detect_kotlin_version(project_root)
  local root = project_root or M.find_project_root(vim.fn.expand("%:p"))
  if not root then
    return nil
  end

  local files_to_check = {
    root .. "/gradle/libs.versions.toml",
    root .. "/settings.gradle.kts",
    root .. "/settings.gradle",
    root .. "/build.gradle.kts",
    root .. "/build.gradle",
    root .. "/gradle.properties",
  }

  for _, filepath in ipairs(files_to_check) do
    if vim.fn.filereadable(filepath) == 1 then
      local ok, lines = pcall(vim.fn.readfile, filepath)
      if ok and lines then
        local content = table.concat(lines, "\n")

        if filepath:match("libs%.versions%.toml$") then
          local in_versions = false
          for _, line in ipairs(lines) do
            local section = line:match("^%s*%[([^%]]+)%]")
            if section then
              in_versions = section == "versions"
            end

            if in_versions then
              local version = line:match("^%s*kotlin%s*=%s*[\"']([^\"']+)[\"']") or
                              line:match("^%s*kotlinVersion%s*=%s*[\"']([^\"']+)[\"']") or
                              line:match("^%s*kotlin%-version%s*=%s*[\"']([^\"']+)[\"']")
              if version then
                return version
              end
            end
          end
        elseif filepath:match("settings%.gradle%.kts$") then
          local version = content:match("kotlin%([\"']jvm[\"']%)%s*version%s*[\"']([^\"']+)[\"']") or
                          content:match("kotlin%([\"']android[\"']%)%s*version%s*[\"']([^\"']+)[\"']") or
                          content:match("kotlin%([\"']multiplatform[\"']%)%s*version%s*[\"']([^\"']+)[\"']") or
                          content:match("id%([\"']org%.jetbrains%.kotlin%.jvm[\"']%)%s*version%s*[\"']([^\"']+)[\"']") or
                          content:match("id%([\"']org%.jetbrains%.kotlin%.android[\"']%)%s*version%s*[\"']([^\"']+)[\"']") or
                          content:match("id%([\"']org%.jetbrains%.kotlin%.multiplatform[\"']%)%s*version%s*[\"']([^\"']+)[\"']")
          if version then
            return version
          end
        elseif filepath:match("settings%.gradle$") then
          local version = content:match("id%s*[\"']org%.jetbrains%.kotlin%.jvm[\"']%s*version%s*[\"']([^\"']+)[\"']") or
                          content:match("id%s*[\"']org%.jetbrains%.kotlin%.android[\"']%s*version%s*[\"']([^\"']+)[\"']") or
                          content:match("id%s*[\"']org%.jetbrains%.kotlin%.multiplatform[\"']%s*version%s*[\"']([^\"']+)[\"']")
          if version then
            return version
          end
        elseif filepath:match("build%.gradle%.kts$") then
          local version = content:match("kotlin%([\"']jvm[\"']%)%s*version%s*[\"']([^\"']+)[\"']") or
                          content:match("kotlin%([\"']android[\"']%)%s*version%s*[\"']([^\"']+)[\"']") or
                          content:match("kotlin%([\"']multiplatform[\"']%)%s*version%s*[\"']([^\"']+)[\"']") or
                          content:match("id%([\"']org%.jetbrains%.kotlin%.jvm[\"']%)%s*version%s*[\"']([^\"']+)[\"']") or
                          content:match("id%([\"']org%.jetbrains%.kotlin%.android[\"']%)%s*version%s*[\"']([^\"']+)[\"']") or
                          content:match("id%([\"']org%.jetbrains%.kotlin%.multiplatform[\"']%)%s*version%s*[\"']([^\"']+)[\"']")
          if version then
            return version
          end
        elseif filepath:match("build%.gradle$") then
          local version = content:match("id%s*[\"']org%.jetbrains%.kotlin%.jvm[\"']%s*version%s*[\"']([^\"']+)[\"']") or
                          content:match("id%s*[\"']org%.jetbrains%.kotlin%.android[\"']%s*version%s*[\"']([^\"']+)[\"']") or
                          content:match("id%s*[\"']org%.jetbrains%.kotlin%.multiplatform[\"']%s*version%s*[\"']([^\"']+)[\"']") or
                          content:match("classpath%s*[\"']org%.jetbrains%.kotlin:kotlin%-gradle%-plugin:([^\"']+)[\"']")
          if version then
            return version
          end
        elseif filepath:match("gradle%.properties$") then
          local version = content:match("kotlinVersion%s*=%s*([^\n%s]+)") or
                          content:match("kotlin%.version%s*=%s*([^\n%s]+)")
          if version then
            return version
          end
        end
      end
    end
  end

  return nil
end

function M.compare_versions(v1, v2)
  local v1_str = tostring(v1 or "")
  local v2_str = tostring(v2 or "")

  -- Parse major.minor (required) and optional patch
  local v1_major, v1_minor, v1_patch = v1_str:match("^(%d+)%.(%d+)%.?(%d*)")
  local v2_major, v2_minor, v2_patch = v2_str:match("^(%d+)%.(%d+)%.?(%d*)")

  -- If either version is unparseable, return nil to signal an error
  if not v1_major or not v2_major then
    return nil
  end

  local version1 = {
    tonumber(v1_major),
    tonumber(v1_minor),
    tonumber(v1_patch) or 0,
  }
  local version2 = {
    tonumber(v2_major),
    tonumber(v2_minor),
    tonumber(v2_patch) or 0,
  }

  for index = 1, 3 do
    if version1[index] < version2[index] then
      return -1
    end
    if version1[index] > version2[index] then
      return 1
    end
  end

  return 0
end

function M.is_kotlin_2_3_or_higher(project_root)
  local version = M.detect_kotlin_version(project_root)
  if not version then
    return false
  end

  local result = M.compare_versions(version, "2.3.0")
  -- If comparison failed (nil), default to false (use fwcd as safe fallback)
  if result == nil then
    return false
  end

  return result >= 0
end

-- ============================================================================
-- INITIALIZATION
-- ============================================================================

function M.setup()
  -- No commands or keymaps to register.
  -- kotlin-language-server handles its own Gradle sync internally.
end

return M
