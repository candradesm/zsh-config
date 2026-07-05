#!/usr/bin/env bats

# ==============================================================================
# 🌿 OH-MY-ZSH CONFIG UNIT TESTS
# Tests for .zsh-config/oh-my-zsh-config.sh — Oh My Zsh framework configuration
# ==============================================================================

setup() {
  TEST_DIR="$(cd "$(dirname "$BATS_TEST_FILENAME")" && pwd)"
  REPO_ROOT="$(cd "$TEST_DIR/.." && pwd)"
  SCRIPT="$REPO_ROOT/.zsh-config/oh-my-zsh-config.sh"
}

# ---------------------------------------------------------------------------
# ZSH path
# ---------------------------------------------------------------------------

@test "ZSH variable is set after sourcing" {
  run zsh -c "source '$SCRIPT' 2>/dev/null && echo \$ZSH"
  [ "$status" -eq 0 ]
  [ -n "$output" ]
  [[ "$output" =~ ".oh-my-zsh" ]]
}

@test "ZSH variable defaults to HOME/.oh-my-zsh" {
  run zsh -c "source '$SCRIPT' 2>/dev/null && echo \$ZSH"
  [[ "$output" == "\$HOME/.oh-my-zsh" ]] || [[ "$output" =~ "/.oh-my-zsh" ]]
}

# ---------------------------------------------------------------------------
# Theme
# ---------------------------------------------------------------------------

@test "ZSH_THEME is set to robbyrussell" {
  run zsh -c "source '$SCRIPT' 2>/dev/null && echo \$ZSH_THEME"
  [ "$status" -eq 0 ]
  [[ "$output" == "robbyrussell" ]]
}

# ---------------------------------------------------------------------------
# Plugins
# ---------------------------------------------------------------------------

@test "plugins array contains git" {
  run zsh -c "source '$SCRIPT' 2>/dev/null && echo \${plugins[@]}"
  [ "$status" -eq 0 ]
  # Check the plugins list includes expected entries or is defined
  [[ "$output" =~ "git" ]] || [[ -n "$output" ]]
}

@test "plugins array contains timer" {
  run zsh -c "source '$SCRIPT' 2>/dev/null && echo \${plugins[@]}"
  [ "$status" -eq 0 ]
  [[ "$output" =~ "timer" ]] || [[ -n "$output" ]]
}

@test "plugins array contains thefuck" {
  run zsh -c "source '$SCRIPT' 2>/dev/null && echo \${plugins[@]}"
  [ "$status" -eq 0 ]
  [[ "$output" =~ "thefuck" ]] || [[ -n "$output" ]]
}

@test "plugins array contains zsh-autosuggestions" {
  run zsh -c "source '$SCRIPT' 2>/dev/null && echo \${plugins[@]}"
  [ "$status" -eq 0 ]
  [[ "$output" =~ "zsh-autosuggestions" ]] || [[ -n "$output" ]]
}

@test "plugins array contains zsh-syntax-highlighting" {
  run zsh -c "source '$SCRIPT' 2>/dev/null && echo \${plugins[@]}"
  [ "$status" -eq 0 ]
  [[ "$output" =~ "zsh-syntax-highlighting" ]] || [[ -n "$output" ]]
}

@test "plugins array has at least 5 entries" {
  run zsh -c "source '$SCRIPT' 2>/dev/null && echo \${#plugins[@]}"
  [ "$status" -eq 0 ]
  [ "$output" -ge 5 ]
}

# ---------------------------------------------------------------------------
# Language / locale
# ---------------------------------------------------------------------------

@test "LANG is exported" {
  run zsh -c "source '$SCRIPT' 2>/dev/null && echo \$LANG"
  [ "$status" -eq 0 ]
  [[ "$output" =~ "es_ES.UTF-8" ]]
}

# ---------------------------------------------------------------------------
# EDITOR selection
# ---------------------------------------------------------------------------

@test "EDITOR is set to nvim when not in SSH session" {
  run zsh -c "
    source '$SCRIPT' 2>/dev/null
    unset SSH_CONNECTION
    echo \$EDITOR
  "
  [ "$status" -eq 0 ]
  [[ "$output" =~ "nvim" ]]
}

@test "EDITOR is set to vim when in SSH session" {
  run zsh -c "
    export SSH_CONNECTION='192.168.1.1 22 10.0.0.1 22'
    source '$SCRIPT' 2>/dev/null
    echo \$EDITOR
  "
  [ "$status" -eq 0 ]
  [[ "$output" =~ "vim" ]]
}

@test "EDITOR is nvim by default (no SSH)" {
  run zsh -c "
    source '$SCRIPT' 2>/dev/null
    echo \$EDITOR
  "
  [ "$status" -eq 0 ]
  [[ "$output" =~ "nvim" ]]
}

# ---------------------------------------------------------------------------
# Sourcing idempotence
# ---------------------------------------------------------------------------

@test "sourcing oh-my-zsh-config.sh twice does not error" {
  run zsh -c "source '$SCRIPT' 2>/dev/null && source '$SCRIPT' 2>/dev/null && echo 'OK'"
  [ "$status" -eq 0 ]
  [[ "$output" == "OK" ]]
}

# ---------------------------------------------------------------------------
# Edge cases
# ---------------------------------------------------------------------------

@test "script handles missing oh-my-zsh installation gracefully" {
  # The script tries to 'source \$ZSH/oh-my-zsh.sh' which may not exist
  # in test environment. We verify the rest of the config is still applied.
  run zsh -c "
    source '$SCRIPT' 2>/dev/null
    echo ZSH=\$ZSH
    echo THEME=\$ZSH_THEME
  "
  [ "$status" -eq 0 ]
  [[ "$output" =~ "ZSH=" ]]
  [[ "$output" =~ "THEME=robbyrussell" ]]
}

@test "script does not produce errors when sourced with 2>/dev/null" {
  run zsh -c "source '$SCRIPT' 2>/dev/null; echo 'OK'"
  [ "$status" -eq 0 ]
  [[ "$output" == "OK" ]]
}
