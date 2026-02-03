# Zara specific commands and variables
alias updateSecrets="./updateSecrets.sh -update Rv6bmMsjbVVpBygawKZ8aVmPGnRxsD 4RK4sV8sJ3XbUB4x85pcTGEBqbzw3c"
alias reset-global="sudo kill -9 \$(ps -A | grep GlobalProtect | awk '{print \$1}')"

# Zara exported variables
export ZARA_APP_SECRETS_PASSPHRASE='Rv6bmMsjbVVpBygawKZ8aVmPGnRxsD'
export ZARA_KEY_SIGNING_DATA_PASSPHRASE='4RK4sV8sJ3XbUB4x85pcTGEBqbzw3c'
export TOOLVER_DP_TOKEN='cmVmdGtuOjAxOjE3OTEzNjc5NTk6anNtdnFuVWttTnlxOHR1RmVJSm5lQXNxQ0w0'

# Asdf config
export ASDF_DATA_DIR="${HOME}/.asdf"
export PATH="${ASDF_DATA_DIR}/shims:$PATH"
fpath=(${HOME}/.asdf/completions ${fpath})
autoload -Uz compinit && compinit

# Traffic Parrot
alias tp-start="traffic-parrot start --foreground trafficparrot.virtualservice.trafficFilesRootUrl=\"file:/Users/cristianandrades/StudioProjects/mob-zaraappandroid/code/ca-ui-testing/src/main/assets/trafficparrot_mappings\""