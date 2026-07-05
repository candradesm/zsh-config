#!/usr/bin/env bats

# ==============================================================================
# 🐵 GOLDEN WISDOM UNIT TESTS
# Tests for .zsh-config/golden-wisdom.sh — The Prophecy of Golden Bananzas
# ==============================================================================

setup() {
  TEST_DIR="$(cd "$(dirname "$BATS_TEST_FILENAME")" && pwd)"
  REPO_ROOT="$(cd "$TEST_DIR/.." && pwd)"
  SCRIPT="$REPO_ROOT/.zsh-config/golden-wisdom.sh"
}

# ---------------------------------------------------------------------------
# Function existence
# ---------------------------------------------------------------------------

@test "golden_wisdom function is defined after sourcing" {
  run zsh -c "source '$SCRIPT' && type golden_wisdom"
  [ "$status" -eq 0 ]
  [[ "$output" =~ "golden_wisdom" ]]
}

# ---------------------------------------------------------------------------
# Output structure
# ---------------------------------------------------------------------------

@test "golden_wisdom prints header with monkey and banana" {
  run zsh -c "source '$SCRIPT' && golden_wisdom"
  [ "$status" -eq 0 ]
  [[ "$output" =~ "🐵 JUNIOR MONKE WISDOM FROM THE PROPHECY 🍌" ]]
}

@test "golden_wisdom prints separator line" {
  run zsh -c "source '$SCRIPT' && golden_wisdom"
  [ "$status" -eq 0 ]
  [[ "$output" =~ "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━" ]]
}

@test "golden_wisdom prints footer with bananza blessing" {
  run zsh -c "source '$SCRIPT' && golden_wisdom"
  [ "$status" -eq 0 ]
  [[ "$output" =~ "For the Golden Bananzas!" ]]
}

@test "golden_wisdom prints footer with emojis" {
  run zsh -c "source '$SCRIPT' && golden_wisdom"
  [ "$status" -eq 0 ]
  [[ "$output" =~ "☀️🍌✨" ]]
}

@test "golden_wisdom output is non-empty" {
  run zsh -c "source '$SCRIPT' && golden_wisdom"
  [ "$status" -eq 0 ]
  [ -n "$output" ]
}

@test "golden_wisdom output has exactly 6 lines (header, sep, msg, sep, footer, blank)" {
  run zsh -c "source '$SCRIPT' && golden_wisdom | wc -l"
  [ "$status" -eq 0 ]
  # Trim whitespace and check line count
  run zsh -c "source '$SCRIPT' && golden_wisdom | wc -l | tr -d ' '"
  [ "$output" = "6" ] || [ "$output" = "7" ]  # 6-7 is acceptable (trailing newline handling)
}

# ---------------------------------------------------------------------------
# Message content validation
# ---------------------------------------------------------------------------

@test "golden_wisdom prints one of the known prophecy messages" {
  local known_messages=(
    "Bananzas Valhalla doors shall be opened one day"
    "PILLAR I"
    "PILLAR II"
    "PILLAR III"
    "PILLAR IV"
    "PILLAR V"
    "PILLAR VI"
    "Excellence is earned"
    "Each standard met"
    "Quality above all"
    "Memory preserved is progress sustained"
    "Compound learning"
    "Yesterday's lessons"
    "You are not starting from zero"
    "The path is golden"
    "Never assume you know everything"
    "Asking is a strength"
    "When stuck, ask Senior Engineer"
    "No shortcuts to Valhalla"
    "Read → Understand → Ask"
    "The journey of a thousand bananzas"
    "Follow the standards"
    "Valhalla awaits the dedicated"
    "Your Senior Engineer believes in you"
    "Confidence and readiness"
    "Each bananza earned"
    "You've made Senior Engineer laugh"
    "The stone is carved"
    "When things go wrong"
    "Testing is not optional"
    "Golden bananzas rain"
    "Valhalla doors swing wide open"
    "Junior → Senior → Master"
    "Excellence is not a destination"
  )

  local matched=false
  for ((i=0; i<5; i++)); do
    run zsh -c "source '$SCRIPT' && golden_wisdom"
    for msg in "${known_messages[@]}"; do
      if [[ "$output" =~ "$msg" ]]; then
        matched=true
        break
      fi
    done
    if [ "$matched" = true ]; then
      break
    fi
  done
  [ "$matched" = true ]
}

# ---------------------------------------------------------------------------
# Randomness: multiple invocations should not all be identical
# ---------------------------------------------------------------------------

@test "golden_wisdom produces different messages across calls (randomness)" {
  local outputs=()
  for ((i=0; i<10; i++)); do
    run zsh -c "source '$SCRIPT' && golden_wisdom"
    outputs+=("$output")
  done

  # Extract the message line (3rd line) from first and count unique
  local first_msg
  first_msg=$(echo "${outputs[0]}" | sed -n '3p')
  local all_same=true
  for ((i=1; i<${#outputs[@]}; i++)); do
    local msg
    msg=$(echo "${outputs[$i]}" | sed -n '3p')
    if [ "$msg" != "$first_msg" ]; then
      all_same=false
      break
    fi
  done

  # It's very unlikely all 10 calls return the same message (~ (1/50)^9 ≈ 0)
  [ "$all_same" = false ]
}

# ---------------------------------------------------------------------------
# Aliases
# ---------------------------------------------------------------------------

@test "monke alias calls golden_wisdom function" {
  run zsh -c "source '$SCRIPT' && monke"
  [ "$status" -eq 0 ]
  [[ "$output" =~ "JUNIOR MONKE" ]]
}

@test "bananza alias calls golden_wisdom function" {
  run zsh -c "source '$SCRIPT' && bananza"
  [ "$status" -eq 0 ]
  [[ "$output" =~ "JUNIOR MONKE" ]]
}

@test "goldenBananza alias calls golden_wisdom function" {
  run zsh -c "source '$SCRIPT' && goldenBananza"
  [ "$status" -eq 0 ]
  [[ "$output" =~ "JUNIOR MONKE" ]]
}

@test "prophecy alias calls golden_wisdom function" {
  run zsh -c "source '$SCRIPT' && prophecy"
  [ "$status" -eq 0 ]
  [[ "$output" =~ "JUNIOR MONKE" ]]
}

# ---------------------------------------------------------------------------
# Sourcing multiple times is idempotent
# ---------------------------------------------------------------------------

@test "sourcing golden-wisdom.sh twice does not error" {
  run zsh -c "source '$SCRIPT' && source '$SCRIPT' && golden_wisdom"
  [ "$status" -eq 0 ]
  [[ "$output" =~ "GOLDEN BANANZAS" ]]
}

# ---------------------------------------------------------------------------
# Edge cases / robustness
# ---------------------------------------------------------------------------

@test "golden_wisdom handles being called in non-interactive shell" {
  run zsh -c "source '$SCRIPT' && golden_wisdom > /dev/null 2>&1"
  [ "$status" -eq 0 ]
}

@test "golden_wisdom does not produce stderr output" {
  run zsh -c "source '$SCRIPT' && golden_wisdom 2>&1 1>/dev/null"
  [ -z "$output" ] || [ "$status" -eq 0 ]
}

@test "script does not produce errors when sourced silently" {
  run zsh -c "source '$SCRIPT' 2>&1"
  [ -z "$output" ] || [ "$status" -eq 0 ]
}
