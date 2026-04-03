/**
 * OpenCode Notifications Plugin
 *
 * Sends system notifications for key session events:
 *   1. session.idle                          → "Task completed!"
 *   2. session.error                         → "Something went wrong, I need your attention!"
 *   3. permission.asked / permission.updated → "I need permission to do: <summary>"
 *   4. tool.execute.before (question tool)   → "I have a question for you!"
 *
 * Notifications are suppressed when your terminal app is in focus — no noise
 * when you're already looking at the screen.
 *
 * Configuration: edit notifications.config.jsonc to taste. All fields are optional;
 * missing keys fall back to the hardcoded defaults below.
 *
 * Auto-loaded by OpenCode from .opencode/plugins/ (project-level).
 * For global use, copy both files to ~/.config/opencode/plugins/ instead.
 *
 * Platform support: macOS (full), Linux (notifications + sound + X11 focus).
 * Windows is explicitly unsupported.
 */

import os from "node:os"
import fs from "node:fs"

export const NotificationsPlugin = async ({ $ }) => {

  // ── Platform detection ─────────────────────────────────────────────────────
  const PLATFORM = process.platform

  if (PLATFORM === "win32") {
    throw new Error("[NotificationsPlugin] Windows is not supported. This plugin requires macOS or Linux.")
  }

  const isSupported = PLATFORM === "darwin" || PLATFORM === "linux"
  const isMacOS = PLATFORM === "darwin"
  const isLinux = PLATFORM === "linux"

  // ── Shared utilities ────────────────────────────────────────────────────────
  const safe = (s) =>
    String(s)
      .replace(/\\/g, "\\\\")
      .replace(/"/g, '\\"')
      .replace(/\n/g, "\\n")
      .replace(/\r/g, "\\r")

  const extractFilename = (path) =>
    path ? path.split("/").filter(Boolean).pop() : ""

  const runCommand = async (args, options = {}) => {
    const proc = Bun.spawn(args, { stdout: "pipe", stderr: "pipe", ...options })
    await proc.exited
    return proc.exitCode === 0
      ? (await new Response(proc.stdout).text()).trim()
      : null
  }

  // ── JSONC parser ─────────────────────────────────────────────────────────────
  const parseJsonc = (text) => {
    try {
      return JSON.parse(
        text
          .replace(
            /("(?:[^"\\]|\\.)*")|\/\/[^\n\r]*|\/\*[\s\S]*?\*\//g,
            (match, str) => str ?? ""
          )
          .replace(/,(\s*[}\]])/g, "$1")
      )
    } catch (err) {
      console.warn(`[NotificationsPlugin] Failed to parse config, using defaults: ${err.message}`)
      return {}
    }
  }

  // ── Deep merge ───────────────────────────────────────────────────────────────
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
    terminalProcessName: null,
    soundEnabled: true,
    events: {
      idle:       true,
      error:      true,
      permission: true,
      question:   true,
    },
    sounds: {
      idle:       "Glass",
      error:      "Basso",
      permission: "Submarine",
      question:   "Submarine",
    },
    messages: {
      idle:       "Task completed!",
      error:      "Something went wrong, I need your attention!",
      permission: "I need permission to do: {summary}",
      question:   "I have a question for you!",
    },
    dedupeWindowMs: 1500,
    maxRecentNotifications: 100,
  }

  // ── Load user config ─────────────────────────────────────────────────────────
  const configPath = new URL("./notifications.config.jsonc", import.meta.url).pathname
  const configFile = Bun.file(configPath)
  const userOverrides = (await configFile.exists())
    ? parseJsonc(await configFile.text())
    : {}
  const CONFIG = deepMerge(DEFAULTS, userOverrides)

  // ── Debug logger ─────────────────────────────────────────────────────────
  const DEBUG = false
  const logPath = `${os.tmpdir()}/opencode-notify.log`
  const log = (...args) => {
    if (!DEBUG) return
    try {
      const line = `[${new Date().toISOString()}] ${args.join(" ")}\n`
      fs.appendFileSync(logPath, line)
    } catch (err) {
      if (DEBUG) console.error(`[NotificationsPlugin] Log write failed: ${err.message}`)
    }
  }

  // ── Terminal process name detection ──────────────────────────────────────────
  const MACOS_TERMINAL_PROCESS_NAMES = {
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

  const LINUX_TERMINAL_PROCESS_NAMES = {
    ghostty:           "ghostty",
    kitty:             "kitty",
    iterm:             null,
    iterm2:            null,
    wezterm:           "wezterm-gui",
    alacritty:         "alacritty",
    terminal:          null,
    apple_terminal:    null,
    hyper:             "hyper",
    warp:              null,
    vscode:            "code",
    "vscode-insiders": "code-insiders",
  }

  const detectTerminalProcessName = async () => {
    if (CONFIG.terminalProcessName) return CONFIG.terminalProcessName

    const termProgram = (process.env.TERM_PROGRAM ?? "").toLowerCase()
    const nameMap = isMacOS ? MACOS_TERMINAL_PROCESS_NAMES : LINUX_TERMINAL_PROCESS_NAMES
    if (termProgram && nameMap[termProgram]) {
      return nameMap[termProgram]
    }

    if (isMacOS) {
      return detectTerminalViaPsMacOS()
    }
    if (isLinux) {
      return detectTerminalViaProcLinux()
    }
    return null
  }

  const detectTerminalViaPsMacOS = async () => {
    const knownNames = new Set(Object.values(MACOS_TERMINAL_PROCESS_NAMES))
    let pid = process.ppid
    while (pid && pid > 1) {
      const output = await runCommand(["ps", "-o", "comm=,ppid=", "-p", String(pid)])
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

  const detectTerminalViaProcLinux = async () => {
    const knownNames = new Set(Object.values(LINUX_TERMINAL_PROCESS_NAMES).filter(Boolean))
    let pid = process.ppid
    while (pid && pid > 1) {
      try {
        const comm = (await Bun.file(`/proc/${pid}/comm`).text()).trim()
        if (knownNames.has(comm)) return comm
        const ppidStr = (await Bun.file(`/proc/${pid}/stat`).text()).split(/\s+/)[3]
        const ppid = parseInt(ppidStr)
        if (!ppid || ppid === pid) break
        pid = ppid
      } catch (err) {
        log(`detectTerminalViaProcLinux error: ${err.message}`)
        break
      }
    }
    return null
  }

  const terminalProcessName = await detectTerminalProcessName()

  // ── Focus detection ──────────────────────────────────────────────────────────
  const isTerminalFocused = async () => {
    if (!terminalProcessName) return false

    if (isMacOS) {
      return isTerminalFocusedMacOS()
    }
    if (isLinux) {
      return isTerminalFocusedLinux()
    }
    return false
  }

  const isTerminalFocusedMacOS = async () => {
    const script = `tell application "System Events" to return frontmost of process "${safe(terminalProcessName)}"`
    const result = await runCommand(["osascript", "-e", script])
    return result === "true"
  }

  const isTerminalFocusedLinux = async () => {
    const displayServer = detectDisplayServer()

    if (displayServer === "x11") {
      return isTerminalFocusedX11()
    }
    if (displayServer === "wayland") {
      return isTerminalFocusedWayland()
    }
    return false
  }

  const detectDisplayServer = () => {
    if (process.env.XDG_SESSION_TYPE === "x11") return "x11"
    if (process.env.XDG_SESSION_TYPE === "wayland") return "wayland"
    if (process.env.DISPLAY) return "x11"
    if (process.env.WAYLAND_DISPLAY) return "wayland"
    return "unknown"
  }

  const isTerminalFocusedX11 = async () => {
    const winId = await runCommand(["xdotool", "getactivewindow"])
    if (!winId) return false

    const xpropOutput = await runCommand(["xprop", "-id", winId, "_NET_WM_PID"])
    if (!xpropOutput) return false
    const match = xpropOutput.match(/=\s*(\d+)/)
    if (!match) return false
    const winPid = parseInt(match[1])

    try {
      const procName = (await Bun.file(`/proc/${winPid}/comm`).text()).trim()
      return procName === terminalProcessName
    } catch (err) {
      log(`isTerminalFocusedX11 error: ${err.message}`)
      return false
    }
  }

  const isTerminalFocusedWayland = async () => {
    const focused = await getFocusedWindowWayland()
    if (!focused) return false
    return focused === terminalProcessName
  }

  const getFocusedWindowWayland = async () => {
    if (process.env.XDG_CURRENT_DESKTOP?.includes("GNOME")) {
      return getFocusedWindowGnome()
    }
    if (process.env.XDG_CURRENT_DESKTOP?.includes("KDE")) {
      return getFocusedWindowKde()
    }
    return null
  }

  const getFocusedWindowGnome = async () => {
    const output = await runCommand([
      "busctl", "--user", "call",
      "org.gnome.Shell",
      "/org/gnome/Shell",
      "org.gnome.Shell.Eval",
      "s", "global.display.get_focus_actor()?.get_first_child()?.get_meta('x11-display') || ''"
    ])
    if (!output) return null
    const match = output.match(/"(.*)"/)
    return match ? match[1] : null
  }

  const getFocusedWindowKde = async () => {
    const output = await runCommand([
      "qdbus", "org.kde.KWin", "/KWin", "org.kde.KWin.activeWindowCaption"
    ])
    return output || null
  }

  // ── Sound file validation ────────────────────────────────────────────────────
  const FALLBACK_SOUNDS = {
    darwin: "Glass",
    linux:  "complete",
  }

  const soundPaths = {
    darwin: (name) => `/System/Library/Sounds/${name}.aiff`,
    linux:  (name) => `/usr/share/sounds/freedesktop/stereo/${name}.oga`,
  }

  const getSoundPath = (name) => {
    const resolver = soundPaths[PLATFORM]
    return resolver ? resolver(name) : null
  }

  const soundFileExists = async (name) => {
    const path = getSoundPath(name)
    if (!path) return false
    try {
      return await Bun.file(path).exists()
    } catch (err) {
      log(`soundFileExists error: ${err.message}`)
      return false
    }
  }

  const validatedSoundName = async (name) => {
    if (await soundFileExists(name)) return name

    const fallback = FALLBACK_SOUNDS[PLATFORM]
    if (fallback && await soundFileExists(fallback)) {
      console.warn(`[NotificationsPlugin] Sound "${name}" not found, using fallback: ${fallback}`)
      return fallback
    }

    console.warn(`[NotificationsPlugin] Sound "${name}" not found and no fallback available, disabling sound`)
    return null
  }

  // ── Notification backend ─────────────────────────────────────────────────────
  const notifyMacOS = async (message, title, sound) => {
    const script = `display notification "${safe(message)}" with title "${safe(title)}"`

    const tasks = [
      (async () => {
        await runCommand(["osascript", "-e", script])
      })(),
    ]

    if (CONFIG.soundEnabled) {
      const soundName = await validatedSoundName(sound)
      if (soundName) {
        const soundPath = getSoundPath(soundName)
        tasks.push(
          (async () => {
            await runCommand(["afplay", soundPath])
          })()
        )
      }
    }

    await Promise.all(tasks)
  }

  const notifyLinux = async (message, title, sound) => {
    const tasks = [
      runCommand(["notify-send", title, message]),
    ]

    if (CONFIG.soundEnabled) {
      const soundName = await validatedSoundName(sound)
      if (soundName) {
        const soundPath = getSoundPath(soundName)
        if (soundPath) {
          tasks.push(
            (async () => {
              await runCommand(["paplay", soundPath])
            })()
          )
        }
      }
    }

    await Promise.all(tasks)
  }

  const notify = async (message, title = "OpenCode", sound = "Glass") => {
    if (!isSupported) return

    if (isMacOS) {
      await notifyMacOS(message, title, sound)
    } else if (isLinux) {
      await notifyLinux(message, title, sound)
    }
  }

  // ── Deduplication ─────────────────────────────────────────────────────────
  const recentNotifications = new Map()

  const shouldNotify = (key) => {
    const now = Date.now()
    const windowMs = CONFIG.dedupeWindowMs
    const maxEntries = CONFIG.maxRecentNotifications
    const expiredKeys = []
    for (const [k, ts] of recentNotifications) {
      if (now - ts >= windowMs) expiredKeys.push(k)
    }
    for (const k of expiredKeys) recentNotifications.delete(k)

    if (recentNotifications.size >= maxEntries) {
      const sorted = [...recentNotifications.entries()].sort((a, b) => a[1] - b[1])
      const toRemove = sorted.slice(0, sorted.length - maxEntries + 1)
      for (const [k] of toRemove) recentNotifications.delete(k)
    }

    const last = recentNotifications.get(key)
    if (last !== undefined && now - last < windowMs) return false
    recentNotifications.set(key, now)
    return true
  }

  // ── Permission payload parser ─────────────────────────────────────────────
  const toSummary = (event) => {
    if (!event || typeof event !== "object") return "unknown operation"
    const props      = event.properties ?? {}
    const permission = props.permission ?? ""
    const meta       = props.metadata   ?? {}

    switch (permission) {
      case "external_directory": {
        const path = meta.filepath ?? meta.parentDir ?? (props.patterns ?? [])[0] ?? ""
        const name = extractFilename(path)
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
        const label = permission ? permission.replace(/_/g, " ") : "external operation"
        const path  = meta.filepath ?? meta.parentDir ?? ""
        const name  = extractFilename(path)
        return name ? `${label}: ${name}` : label
      }
    }
  }

  const permissionKey = (event) => {
    const id = event?.properties?.id ?? event?.properties?.tool?.callID
    return id ? `permission:${id}` : `permission:anon-${Date.now()}-${Math.random().toString(36).slice(2)}`
  }

  // ── Event handler helper ──────────────────────────────────────────────────
  const handleNotificationEvent = async (eventType, configKey, extraLog = "") => {
    if (!CONFIG.events[configKey]) return false
    const focused = await isTerminalFocused()
    log(`${eventType} | terminalProcessName=${terminalProcessName} | focused=${focused}${extraLog}`)
    if (focused) return false
    await notify(CONFIG.messages[configKey], "OpenCode", CONFIG.sounds[configKey])
    return true
  }

  // ── Startup health check ─────────────────────────────────────────────────
  const runHealthCheck = async () => {
    const results = {
      platform: PLATFORM,
      supported: isSupported,
      terminalDetected: !!terminalProcessName,
      terminalProcessName,
      configLoaded: Object.keys(userOverrides).length > 0,
    }

    if (isSupported) {
      const idleSound = await soundFileExists(CONFIG.sounds.idle)
      results.soundsValid = idleSound
      if (!idleSound) {
        console.warn(`[NotificationsPlugin] Default sound "${CONFIG.sounds.idle}" not found on this platform`)
      }
    }

    log(`HEALTH | ${JSON.stringify(results)}`)
    return results
  }

  await runHealthCheck()

  // ── Plugin hooks ──────────────────────────────────────────────────────────
  return {
    event: async ({ event }) => {
      if (!isSupported) return

      if (event.type === "session.idle") {
        await handleNotificationEvent("session.idle", "idle")
        return
      }

      if (event.type === "session.error") {
        await handleNotificationEvent("session.error", "error")
        return
      }

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

    "tool.execute.before": async (input) => {
      if (!isSupported) return
      const toolName = typeof input?.tool === "string" ? input.tool : ""
      log(`tool.execute.before | tool=${JSON.stringify(toolName)} | input keys=${Object.keys(input ?? {}).join(",")}`)
      if (toolName.toLowerCase() !== "question") return
      if (!CONFIG.events.question) return
      const focused = await isTerminalFocused()
      log(`tool.execute.before(question) | terminalProcessName=${terminalProcessName} | focused=${focused}`)
      if (focused) return
      await notify(CONFIG.messages.question, "OpenCode", CONFIG.sounds.question)
    },
  }
}
