# Required for Android development
export ANDROID_SDK_ROOT="$HOME/Library/Android/sdk"     # Android SDK path
export ANDROID_HOME="$HOME/Library/Android/sdk"         # Alternative name

# Optional Gradle settings (with defaults)
export GRADLE_CACHE="true"                              # Enable classpath caching
export GRADLE_JVM_TARGET="17"                           # JVM target version (auto-detected from project)
export GRADLE_AUTO_SYNC="false"                         # Auto-sync on gradle file save
export GRADLE_TIMEOUT="60000"                           # Gradle sync timeout in ms (Lua fallback when unset: 120000)
export GRADLE_FEEDBACK="medium"                         # Feedback level: minimal, medium, verbose
export GRADLE_CACHE_DIR="$HOME/.cache/nvim/gradle"      # Cache directory

# Legacy variable names (still supported for backward compatibility)
# ANDROID_KLS_CACHE="true"                       # Same as GRADLE_CACHE
# ANDROID_KLS_JVM_TARGET="17"                    # Same as GRADLE_JVM_TARGET
# ANDROID_AUTO_SYNC="false"                      # Same as GRADLE_AUTO_SYNC
# NVIM_ANDROID_CACHE_DIR="~/.cache/nvim/gradle"  # Same as GRADLE_CACHE_DIR
