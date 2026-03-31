# Zara specific commands and variables
alias updateSecrets="./updateSecrets.sh -update <REPLACE_PASSPHRASE_1> <REPLACE_PASSPHRASE_2>"
alias reset-global="sudo kill -9 \$(ps -A | grep GlobalProtect | awk '{print \$1}')"

# Zara exported variables
export ZARA_APP_SECRETS_PASSPHRASE='<REPLACE_ME>'
export ZARA_KEY_SIGNING_DATA_PASSPHRASE='<REPLACE_ME>'
export TOOLVER_DP_TOKEN='<REPLACE_ME>'

# Asdf config
export ASDF_DATA_DIR="${HOME}/.asdf"
export PATH="${ASDF_DATA_DIR}/shims:$PATH"
fpath=(${HOME}/.asdf/completions ${fpath})
autoload -Uz compinit && compinit

# Traffic Parrot
alias tp-start="traffic-parrot start --foreground trafficparrot.virtualservice.trafficFilesRootUrl=\"file:<REPLACE_LOCAL_PATH>/trafficparrot_mappings\""
