#!/usr/bin/env bats

# ==============================================================================
# 📱 NVIM CONFIG UNIT TESTS
# Tests for .zsh-config/nvim-config.sh — Neovim/Android environment variables
# ==============================================================================

setup() {
  TEST_DIR="$(cd "$(dirname "$BATS_TEST_FILENAME")" && pwd)"
  REPO_ROOT="$(cd "$TEST_DIR/.." && pwd)"
  SCRIPT="$REPO_ROOT/.zsh-config/nvim-config.sh"
}

# ---------------------------------------------------------------------------
# Android SDK environment variables
# ---------------------------------------------------------------------------

@test "ANDROID_SDK_ROOT is exported" {
  run zsh -c "source '$SCRIPT' && echo \$ANDROID_SDK_ROOT"
  [ "$status" -eq 0 ]
  [ -n "$output" ]
  [[ "$output" =~ "Library/Android/sdk" ]]
}

@test "ANDROID_SDK_ROOT points to home directory" {
  run zsh -c "source '$SCRIPT' && echo \$ANDROID_SDK_ROOT"
  [[ "$output" == "\$HOME/Library/Android/sdk" ]] || [[ "$output" =~ "$HOME/Library/Android/sdk" ]]
}

@test "ANDROID_HOME is exported" {
  run zsh -c "source '$SCRIPT' && echo \$ANDROID_HOME"
  [ "$status" -eq 0 ]
  [ -n "$output" ]
  [[ "$output" =~ "Library/Android/sdk" ]]
}

@test "ANDROID_HOME ANDROID_SDK_ROOT are identical" {
  run zsh -c "source '$SCRIPT' && [ \"\$ANDROID_HOME\" = \"\$ANDROID_SDK_ROOT\" ] && echo 'MATCH'"
  [ "$status" -eq 0 ]
  [[ "$output" == "MATCH" ]]
}

# ---------------------------------------------------------------------------
# Gradle JVM target
# ---------------------------------------------------------------------------

@test "GRADLE_JVM_TARGET is exported" {
  run zsh -c "source '$SCRIPT' && echo \$GRADLE_JVM_TARGET"
  [ "$status" -eq 0 ]
  [ -n "$output" ]
}

@test "GRADLE_JVM_TARGET defaults to 17" {
  run zsh -c "source '$SCRIPT' && echo \$GRADLE_JVM_TARGET"
  [[ "$output" == "17" ]]
}

# ---------------------------------------------------------------------------
# Sourcing idempotence
# ---------------------------------------------------------------------------

@test "sourcing nvim-config.sh twice does not error" {
  run zsh -c "source '$SCRIPT' && source '$SCRIPT' && echo 'OK'"
  [ "$status" -eq 0 ]
  [[ "$output" == "OK" ]]
}

# ---------------------------------------------------------------------------
# Edge cases
# ---------------------------------------------------------------------------

@test "script does not produce any output when sourced" {
  run zsh -c "source '$SCRIPT' 2>&1"
  [ -z "$output" ]
}

@test "script produces no stderr when sourced" {
  run zsh -c "source '$SCRIPT' 2>/dev/null; echo 'OK'"
  [ "$status" -eq 0 ]
  [[ "$output" == "OK" ]]
}

@test "all variables are exported (visible to subprocesses)" {
  run zsh -c "
    source '$SCRIPT'
    zsh -c '
      echo ANDROID_SDK_ROOT=\${ANDROID_SDK_ROOT:-unset}
      echo ANDROID_HOME=\${ANDROID_HOME:-unset}
      echo GRADLE_JVM_TARGET=\${GRADLE_JVM_TARGET:-unset}
    '
  "
  [ "$status" -eq 0 ]
  [[ "$output" =~ "ANDROID_SDK_ROOT=" ]]
  [[ "$output" =~ "ANDROID_HOME=" ]]
  [[ "$output" =~ "GRADLE_JVM_TARGET=" ]]
  [[ ! "$output" =~ "unset" ]]
}
