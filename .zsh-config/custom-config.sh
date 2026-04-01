# General utility commands
git-stats() {
    git log --author="$(git config user.name)" --pretty=tformat: --numstat | \
        awk '{ add += $1; subs += $2; total += $1 + $2; diff += $1 - $2 } END { printf "added lines: %s, removed lines: %s, total lines: %s, diff: %s\n", add, subs, total, diff }' -
}

alias java17="/opt/homebrew/opt/openjdk@17/libexec/openjdk.jdk/Contents/Home/bin/java"
alias java21="/opt/homebrew/opt/openjdk@21/libexec/openjdk.jdk/Contents/Home/bin/java"

# General exported variables
export JAVA_HOME=/opt/homebrew/opt/openjdk@21/libexec/openjdk.jdk/Contents/Home/
export OPENPROJECT_BASE_URL=https://openproject.napptilus.com

nano() {
  command nano "$@"
  echo "No Senior shall execute nano. Good senior only executes nvim. $fg[green]nvim is the senior way, nvim is life\n"
}
