/**
 * OpenCode Notifications Plugin
 *
 * Sends macOS system notifications for key session events:
 *   1. session.idle                          → "Task completed!"
 *   2. session.error                         → "Something went wrong, I need your attention!"
 *   3. permission.asked / permission.updated → "I need permission to do: <summary>"
 *   4. tool.execute.before (question tool)   → "I have a question for you!"
 *
 * Notifications are suppressed when your terminal app is in focus — no noise
 * when you're already looking at the screen.
 *
 * Configuration: copy notifications.config.example.jsonc → notifications.config.jsonc
 * (gitignored) and edit to taste. All fields are optional; missing keys fall back
 * to the hardcoded defaults below.
 *
 * Auto-loaded by OpenCode from .opencode/plugins/ (project-level).
 * For global use, copy both files to ~/.config/opencode/plugins/ instead.
 */

export const NotificationsPlugin = async ({ $ }) => {

  // ── JSONC parser ─────────────────────────────────────────────────────────────
  // Strips comments and trailing commas before handing off to JSON.parse.
  // The alternation matches string literals first so that "//" inside a value
  // (e.g. a URL like "https://...") is never treated as a comment.
  const parseJsonc = (text) => JSON.parse(
    text
      .replace(
        /("(?:[^"\\]|\\.)*")|\/\/[^\n\r]*|\/\*[\s\S]*?\*\//g,
        (match, str) => str ?? ""   // keep string literals; erase comments
      )
      .replace(/,(\s*[}\]])/g, "$1")  // trailing commas
  )

  // ── Deep merge ───────────────────────────────────────────────────────────────
  // Recursively merges `source` into `target`. Arrays and primitives in source
  // replace those in target; plain objects are merged recursively.
  const deepMerge = (target, source) => {
    const result = { ...target }
    for (const key of Object.keys(source)) {
      if (
        source[key] !== null &&
        typeof source[key] === "object" &&
        !Array.isArray(source[key])
      ) {
        result[key] = deepMerge(target[key] ?? {}, source[key])
      } else {
        result[key] = source[key]
      }
    }
    return result
  }

  // ── Defaults ─────────────────────────────────────────────────────────────────
  const DEFAULTS = {
    // macOS process name of the terminal running OpenCode.
    // null = auto-detected; set a string to override (e.g. "Ghostty").
    terminalProcessName: null,

    // Master sound toggle.
    soundEnabled: true,

    // Per-event enable/disable.
    events: {
      idle:       true,
      error:      true,
      permission: true,
      question:   true,
    },

    // Per-event sound (stem of /System/Library/Sounds/<name>.aiff).
    sounds: {
      idle:       "Glass",
      error:      "Basso",
      permission: "Submarine",
      question:   "Submarine",
    },

    // Per-event notification messages.
    // In "permission", {summary} is replaced with a short description of the tool action.
    messages: {
      idle:       "Task completed!",
      error:      "Something went wrong, I need your attention!",
      permission: "I need permission to do: {summary}",
      question:   "I have a question for you!",
    },
  }

  // ── Load user config ─────────────────────────────────────────────────────────
  // Resolve config path relative to this plugin file so it works regardless of
  // the working directory OpenCode is launched from.
  const configPath = new URL("./notifications.config.jsonc", import.meta.url).pathname
  const configFile = Bun.file(configPath)
  const userOverrides = (await configFile.exists())
    ? parseJsonc(await configFile.text())
    : {}
  const CONFIG = deepMerge(DEFAULTS, userOverrides)

  // ── Terminal process name detection ──────────────────────────────────────────
  // Maps $TERM_PROGRAM values (lowercased) to macOS process names.
  // Source: https://github.com/kdcokenny/opencode-notify
  const TERMINAL_PROCESS_NAMES = {
    ghostty:           "Ghostty",
    kitty:             "kitty",
    iterm:             "iTerm2",
    iterm2:            "iTerm2",
    wezterm:           "WezTerm",
    alacritty:         "Alacritty",
    terminal:          "Terminal",
    apple_terminal:    "Terminal",
    hyper:             "Hyper",
    warp:              "Warp",
    vscode:            "Code",
    "vscode-insiders": "Code - Insiders",
  }

  /**
   * Returns the macOS process name of the terminal running OpenCode, or null.
   *
   * Detection order:
   *   1. Manual override from config (terminalProcessName field)
   *   2. $TERM_PROGRAM env var → TERMINAL_PROCESS_NAMES lookup
   *   3. Walk the parent process tree via `ps` until a known name is found
   */
  const detectTerminalProcessName = async () => {
    // 1. Manual config override
    if (CONFIG.terminalProcessName) return CONFIG.terminalProcessName

    // 2. $TERM_PROGRAM env var
    const termProgram = (process.env.TERM_PROGRAM ?? "").toLowerCase()
    if (termProgram && TERMINAL_PROCESS_NAMES[termProgram]) {
      return TERMINAL_PROCESS_NAMES[termProgram]
    }

    // 3. Walk parent process tree
    const knownNames = new Set(Object.values(TERMINAL_PROCESS_NAMES))
    let pid = process.ppid
    while (pid && pid > 1) {
      const proc = Bun.spawn(["ps", "-o", "comm=,ppid=", "-p", String(pid)], {
        stdout: "pipe",
        stderr: "pipe",
      })
      await proc.exited
      const output = (await new Response(proc.stdout).text()).trim()
      if (!output) break
      const parts = output.split(/\s+/)
      const comm  = parts[0]
      const ppid  = parseInt(parts[1])
      if (knownNames.has(comm)) return comm
      if (!ppid || ppid === pid) break
      pid = ppid
    }

    return null
  }

  // Detect once at startup; reused for every isTerminalFocused() call.
  const terminalProcessName = await detectTerminalProcessName()

  /**
   * Returns true if the detected terminal is currently the frontmost macOS app.
   * Always returns false when the terminal could not be detected (never suppresses).
   *
   * We ask "is <terminal> frontmost?" rather than "who is frontmost globally?"
   * because the global query can return the terminal's name even when the user
   * is on a different Space (no other window has focus on that Space).
   * Querying the process directly returns false as soon as the user switches away.
   */
  const isTerminalFocused = async () => {
    if (!terminalProcessName) return false
    const safe   = (s) => s.replace(/"/g, '\\"')
    const script = `tell application "System Events" to return frontmost of process "${safe(terminalProcessName)}"`
    const proc = Bun.spawn(
      ["osascript", "-e", script],
      { stdout: "pipe", stderr: "pipe" }
    )
    await proc.exited
    // If osascript errors (e.g. process not found), default to false = allow notification.
    if (proc.exitCode !== 0) return false
    const result = (await new Response(proc.stdout).text()).trim()
    return result === "true"
  }

  // ── Deduplication ─────────────────────────────────────────────────────────
  // Prevents double notifications when multiple events fire for the same action
  // (e.g. permission.asked + permission.updated for the same request).
  const DEDUPE_WINDOW_MS = 1500
  /** @type {Map<string, number>} key → timestamp of last notification sent */
  const recentNotifications = new Map()

  const shouldNotify = (key) => {
    const now = Date.now()
    for (const [k, ts] of recentNotifications) {
      if (now - ts >= DEDUPE_WINDOW_MS) recentNotifications.delete(k)
    }
    const last = recentNotifications.get(key)
    if (last !== undefined && now - last < DEDUPE_WINDOW_MS) return false
    recentNotifications.set(key, now)
    return true
  }

  // ── Notification sender ───────────────────────────────────────────────────
  /**
   * Sends a macOS notification with optional sound — no external dependencies.
   *
   * osascript delivers the visual banner. afplay plays the .aiff directly
   * (reliable, bypasses Notification Center sound settings). Both run
   * concurrently via Promise.all — afplay must be awaited or Bun kills the
   * child process before the clip finishes.
   * Notification style (Banner vs Alert) is set via:
   *   System Settings → Notifications → Script Editor
   */
  const notify = async (message, title = "OpenCode", sound = "Glass") => {
    const safe   = (s) => s.replace(/"/g, '\\"')
    const script = `display notification "${safe(message)}" with title "${safe(title)}"`
    const tasks  = [
      (async () => {
        const proc = Bun.spawn(["osascript", "-e", script], { stdout: "pipe", stderr: "pipe" })
        await proc.exited
      })(),
    ]
    if (CONFIG.soundEnabled) {
      tasks.push($`afplay /System/Library/Sounds/${sound}.aiff`.nothrow())
    }
    await Promise.all(tasks)
  }

  // ── Permission payload parser ─────────────────────────────────────────────
  /**
   * Converts a permission event payload into a natural-language summary.
   *
   * Actual payload structure (from runtime inspection):
   *   event.properties.permission  — e.g. "external_directory", "network", "shell"
   *   event.properties.metadata    — { filepath?, parentDir?, url?, command?, ... }
   *   event.properties.tool        — { messageID, callID }  ← no name here
   */
  const toSummary = (event) => {
    const props      = event?.properties ?? {}
    const permission = props.permission ?? ""
    const meta       = props.metadata   ?? {}

    switch (permission) {
      case "external_directory": {
        const path = meta.filepath ?? meta.parentDir ?? (props.patterns ?? [])[0] ?? ""
        const name = path ? path.split("/").filter(Boolean).pop() : ""
        return name ? `access: ${name}` : path ? `access: ${path}` : "access external file"
      }
      case "network": {
        const url = meta.url ?? meta.host ?? ""
        return url ? `network request: ${url}` : "make a network request"
      }
      case "shell": {
        const cmd    = meta.command ?? meta.cmd ?? ""
        const tokens = String(cmd).trim().split(/\s+/).slice(0, 5)
        return tokens.length ? `run: ${tokens.join(" ")}` : "run a shell command"
      }
      default: {
        // Generic fallback: prettify the permission type + any filepath hint
        const label = permission ? permission.replace(/_/g, " ") : "external operation"
        const path  = meta.filepath ?? meta.parentDir ?? ""
        const name  = path ? path.split("/").filter(Boolean).pop() : ""
        return name ? `${label}: ${name}` : label
      }
    }
  }
  // ── Dedup key helper ─────────────────────────────────────────────────────
  const permissionKey = (event) => {
    const id = event?.properties?.id ?? event?.properties?.tool?.callID
    return id ? `permission:${id}` : `permission:${Date.now()}`
  }

  // ── Debug logger ─────────────────────────────────────────────────────────
  // Set DEBUG = true to write a timestamped log to /tmp/opencode-notify.log.
  // Flip back to false once diagnosis is done.
  const DEBUG = false
  const logPath = "/tmp/opencode-notify.log"
  const { appendFileSync } = await import("node:fs")
  const log = (...args) => {
    if (!DEBUG) return
    try {
      const line = `[${new Date().toISOString()}] ${args.join(" ")}\n`
      appendFileSync(logPath, line)
    } catch { /* ignore log errors so they never break hooks */ }
  }

  // Startup marker — confirms the plugin loaded and terminal was detected.
  log(`STARTUP | terminalProcessName=${terminalProcessName}`)

  // ── Plugin hooks ──────────────────────────────────────────────────────────
  return {
    event: async ({ event }) => {

      // 1. Session complete
      if (event.type === "session.idle") {
        if (!CONFIG.events.idle) return
        const focused = await isTerminalFocused()
        log(`session.idle | terminalProcessName=${terminalProcessName} | focused=${focused}`)
        if (focused) return
        await notify(CONFIG.messages.idle, "OpenCode", CONFIG.sounds.idle)
        return
      }

      // 2. Session error
      if (event.type === "session.error") {
        if (!CONFIG.events.error) return
        const focused = await isTerminalFocused()
        log(`session.error | terminalProcessName=${terminalProcessName} | focused=${focused}`)
        if (focused) return
        await notify(CONFIG.messages.error, "OpenCode", CONFIG.sounds.error)
        return
      }

      // 3. Permission needed — dedup covers asked + updated firing for same request
      if (event.type === "permission.asked" || event.type === "permission.updated") {
        if (!CONFIG.events.permission) return
        const focused = await isTerminalFocused()
        log(`${event.type} | focused=${focused} | payload=${JSON.stringify(event)}`)
        if (focused) return
        if (!shouldNotify(permissionKey(event))) return
        const summary = toSummary(event)
        const message = CONFIG.messages.permission.replace("{summary}", summary)
        await notify(message, "OpenCode", CONFIG.sounds.permission)
        return
      }
    },

    // 4. Question — handled exclusively via tool.execute.before (not question.asked)
    // to guarantee exactly one notification; the two events fire far enough apart
    // that dedup cannot reliably suppress the second one.
    "tool.execute.before": async (input) => {
      log(`tool.execute.before | tool=${JSON.stringify(input?.tool)} | input keys=${Object.keys(input ?? {}).join(",")}`)
      if ((input?.tool ?? "").toLowerCase() !== "question") return
      if (!CONFIG.events.question) return
      const focused = await isTerminalFocused()
      log(`tool.execute.before(question) | terminalProcessName=${terminalProcessName} | focused=${focused}`)
      if (focused) return
      await notify(CONFIG.messages.question, "OpenCode", CONFIG.sounds.question)
    },
  }
}
