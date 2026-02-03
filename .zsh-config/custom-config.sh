# General utility commands
alias git-stats="git log --author=\"Cristian Andrades\" --pretty=tformat: --numstat | \
    awk '{ add += \$1; subs += \$2; total += \$1 + \$2; diff += \$1 - \$2 } END { printf \"added lines: %s, removed lines: %s, total lines: %s, diff: %s\n\", add, subs, total, diff }' -"

alias updateSecrets="./updateSecrets.sh -update Rv6bmMsjbVVpBygawKZ8aVmPGnRxsD 4RK4sV8sJ3XbUB4x85pcTGEBqbzw3c"

alias java17="/opt/homebrew/opt/openjdk@17/libexec/openjdk.jdk/Contents/Home/bin/java"
alias java21="/opt/homebrew/opt/openjdk@21/libexec/openjdk.jdk/Contents/Home/bin/java"

alias reset-global="sudo kill -9 \$(ps -A | grep GlobalProtect | awk '{print \$1}')"

# General exported variables
export JAVA_HOME=/opt/homebrew/opt/openjdk@21/libexec/openjdk.jdk/Contents/Home/
export ZARA_APP_SECRETS_PASSPHRASE='Rv6bmMsjbVVpBygawKZ8aVmPGnRxsD'
export ZARA_KEY_SIGNING_DATA_PASSPHRASE='4RK4sV8sJ3XbUB4x85pcTGEBqbzw3c'
export TOOLVER_DP_TOKEN='cmVmdGtuOjAxOjE3OTEzNjc5NTk6anNtdnFuVWttTnlxOHR1RmVJSm5lQXNxQ0w0'
export OPENCODE_DISABLE_AUTOCOMPACT=false

# Asdf config
export ASDF_DATA_DIR="${HOME}/.asdf"
export PATH="${ASDF_DATA_DIR}/shims:$PATH"
fpath=(${HOME}/.asdf/completions ${fpath})
autoload -Uz compinit && compinit

# Traffic Parrot
alias tp-start="traffic-parrot start --foreground trafficparrot.virtualservice.trafficFilesRootUrl=\"file:/Users/cristianandrades/StudioProjects/mob-zaraappandroid/code/ca-ui-testing/src/main/assets/trafficparrot_mappings\""

nano() {
  command nano "$@"
  echo "No Senior shall execute nano. Good senior only executes nvim. $fg[green]nvim is the senior way, nvim is life\n"
}
