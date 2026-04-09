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

interface NotificationEventConfig {
  idle: boolean
  error: boolean
  permission: boolean
  question: boolean
}

interface SoundConfig {
  idle: string
  error: string
  permission: string
  question: string
}

interface MessageConfig {
  idle: string
  error: string
  permission: string
  question: string
}

interface NotificationsConfig {
  terminalProcessName: string | null
  soundEnabled: boolean
  events: NotificationEventConfig
  sounds: SoundConfig
  messages: MessageConfig
  dedupeWindowMs: number
  maxRecentNotifications: number
}

type TerminalProcessMap = Record<string, string | null>

interface TrackedSession {
  parentID?: string
  title?: string
}

interface PermissionEventProperties {
  permission?: string
  metadata?: Record<string, unknown>
  patterns?: string[]
  [key: string]: unknown
}

interface SessionEventProperties {
  sessionID?: string
  info?: {
    parentID?: string
    title?: string
  }
  [key: string]: unknown
}

interface PluginEvent {
  type: string
  properties?: SessionEventProperties | PermissionEventProperties | Record<string, unknown>
}

interface ToolExecuteInput {
  tool?: string
  [key: string]: unknown
}

export const NotificationsPlugin = async ({ $ }: { $: typeof import("bun").$ }) => {

  const PLATFORM = process.platform

  if (PLATFORM === "win32") {
    throw new Error("[NotificationsPlugin] Windows is not supported. This plugin requires macOS or Linux.")
  }

  const isSupported: boolean = PLATFORM === "darwin" || PLATFORM === "linux"
  const isMacOS: boolean = PLATFORM === "darwin"
  const isLinux: boolean = PLATFORM === "linux"

  const safe = (s: string): string =>
    String(s)
      .replace(/\\/g, "\\\\")
      .replace(/"/g, '\\"')
      .replace(/\n/g, "\\n")
      .replace(/\r/g, "\\r")

  const extractFilename = (path: string): string =>
    path ? path.split("/").filter(Boolean).pop() ?? "" : ""

  const runCommand = async (args: string[], options: Record<string, unknown> = {}): Promise<string | null> => {
    const proc = Bun.spawn(args, { stdout: "pipe", stderr: "pipe", ...options })
    await proc.exited
    return proc.exitCode === 0
      ? (await new Response(proc.stdout).text()).trim()
      : null
  }

  const parseJsonc = (text: string): Partial<NotificationsConfig> => {
    try {
      return JSON.parse(
        text
          .replace(
            /("(?:[^"\\]|\\.)*")|\/\/[^\n\r]*|\/\*[\s\S]*?\*\//g,
            (match: string, str: string) => str ?? ""
          )
          .replace(/,(\s*[}\]])/g, "$1")
      )
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err)
      console.warn(`[NotificationsPlugin] Failed to parse config, using defaults: ${message}`)
      return {}
    }
  }

  const deepMerge = <T extends Record<string, unknown>>(target: T, source: Partial<T>): T => {
    const result = { ...target }
    for (const key of Object.keys(source) as Array<keyof T>) {
      if (
        source[key] !== null &&
        typeof source[key] === "object" &&
        !Array.isArray(source[key])
      ) {
        (result as Record<string, unknown>)[key as string] = deepMerge(
          (target[key] ?? {}) as Record<string, unknown>,
          (source[key] ?? {}) as Record<string, unknown>
        )
      } else {
        result[key] = source[key] as T[keyof T]
      }
    }
    return result
  }

  const DEFAULTS: NotificationsConfig = {
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

  const configPath = new URL("./notifications.config.jsonc", import.meta.url).pathname
  const configFile = Bun.file(configPath)
  const userOverrides: Partial<NotificationsConfig> = (await configFile.exists())
    ? parseJsonc(await configFile.text())
    : {}
  const CONFIG: NotificationsConfig = deepMerge(DEFAULTS, userOverrides as Partial<NotificationsConfig>)

  const DEBUG: boolean = false
  const logPath = `${os.tmpdir()}/opencode-notify.log`
  const log = (...args: string[]): void => {
    if (!DEBUG) return
    try {
      const line = `[${new Date().toISOString()}] ${args.join(" ")}\n`
      fs.appendFileSync(logPath, line)
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err)
      if (DEBUG) console.error(`[NotificationsPlugin] Log write failed: ${message}`)
    }
  }

  const MACOS_TERMINAL_PROCESS_NAMES: TerminalProcessMap = {
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

  const LINUX_TERMINAL_PROCESS_NAMES: TerminalProcessMap = {
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

  const detectTerminalProcessName = async (): Promise<string | null> => {
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

  const detectTerminalViaPsMacOS = async (): Promise<string | null> => {
    const knownNames = new Set(Object.values(MACOS_TERMINAL_PROCESS_NAMES).filter((v): v is string => v !== null))
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

  const detectTerminalViaProcLinux = async (): Promise<string | null> => {
    const knownNames = new Set(Object.values(LINUX_TERMINAL_PROCESS_NAMES).filter((v): v is string => v !== null))
    let pid = process.ppid
    while (pid && pid > 1) {
      try {
        const comm = (await Bun.file(`/proc/${pid}/comm`).text()).trim()
        if (knownNames.has(comm)) return comm
        const ppidStr = (await Bun.file(`/proc/${pid}/stat`).text()).split(/\s+/)[3]
        const ppid = parseInt(ppidStr)
        if (!ppid || ppid === pid) break
        pid = ppid
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err)
        log(`detectTerminalViaProcLinux error: ${message}`)
        break
      }
    }
    return null
  }

  const terminalProcessName: string | null = await detectTerminalProcessName()

  const isTerminalFocused = async (): Promise<boolean> => {
    if (!terminalProcessName) return false

    if (isMacOS) {
      return isTerminalFocusedMacOS()
    }
    if (isLinux) {
      return isTerminalFocusedLinux()
    }
    return false
  }

  const isTerminalFocusedMacOS = async (): Promise<boolean> => {
    if (!terminalProcessName) return false
    const script = `tell application "System Events" to return frontmost of process "${safe(terminalProcessName)}"`
    const result = await runCommand(["osascript", "-e", script])
    return result === "true"
  }

  const isTerminalFocusedLinux = async (): Promise<boolean> => {
    const displayServer = detectDisplayServer()

    if (displayServer === "x11") {
      return isTerminalFocusedX11()
    }
    if (displayServer === "wayland") {
      return isTerminalFocusedWayland()
    }
    return false
  }

  const detectDisplayServer = (): string => {
    if (process.env.XDG_SESSION_TYPE === "x11") return "x11"
    if (process.env.XDG_SESSION_TYPE === "wayland") return "wayland"
    if (process.env.DISPLAY) return "x11"
    if (process.env.WAYLAND_DISPLAY) return "wayland"
    return "unknown"
  }

  const isTerminalFocusedX11 = async (): Promise<boolean> => {
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
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err)
      log(`isTerminalFocusedX11 error: ${message}`)
      return false
    }
  }

  const isTerminalFocusedWayland = async (): Promise<boolean> => {
    const focused = await getFocusedWindowWayland()
    if (!focused) return false
    return focused === terminalProcessName
  }

  const getFocusedWindowWayland = async (): Promise<string | null> => {
    if (process.env.XDG_CURRENT_DESKTOP?.includes("GNOME")) {
      return getFocusedWindowGnome()
    }
    if (process.env.XDG_CURRENT_DESKTOP?.includes("KDE")) {
      return getFocusedWindowKde()
    }
    return null
  }

  const getFocusedWindowGnome = async (): Promise<string | null> => {
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

  const getFocusedWindowKde = async (): Promise<string | null> => {
    const output = await runCommand([
      "qdbus", "org.kde.KWin", "/KWin", "org.kde.KWin.activeWindowCaption"
    ])
    return output || null
  }

  const FALLBACK_SOUNDS: Record<string, string> = {
    darwin: "Glass",
    linux:  "complete",
  }

  const soundPaths: Record<string, (name: string) => string> = {
    darwin: (name) => `/System/Library/Sounds/${name}.aiff`,
    linux:  (name) => `/usr/share/sounds/freedesktop/stereo/${name}.oga`,
  }

  const getSoundPath = (name: string): string | null => {
    const resolver = soundPaths[PLATFORM]
    return resolver ? resolver(name) : null
  }

  const soundFileExists = async (name: string): Promise<boolean> => {
    const path = getSoundPath(name)
    if (!path) return false
    try {
      return await Bun.file(path).exists()
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err)
      log(`soundFileExists error: ${message}`)
      return false
    }
  }

  const validatedSoundName = async (name: string): Promise<string | null> => {
    if (await soundFileExists(name)) return name

    const fallback = FALLBACK_SOUNDS[PLATFORM]
    if (fallback && await soundFileExists(fallback)) {
      console.warn(`[NotificationsPlugin] Sound "${name}" not found, using fallback: ${fallback}`)
      return fallback
    }

    console.warn(`[NotificationsPlugin] Sound "${name}" not found and no fallback available, disabling sound`)
    return null
  }

  const notifyMacOS = async (message: string, title: string, sound: string): Promise<void> => {
    const script = `display notification "${safe(message)}" with title "${safe(title)}"`

    const tasks: Promise<unknown>[] = [
      (async () => {
        await runCommand(["osascript", "-e", script])
      })(),
    ]

    if (CONFIG.soundEnabled) {
      const soundName = await validatedSoundName(sound)
      if (soundName) {
        const soundPath = getSoundPath(soundName)
        if (soundPath) {
          tasks.push(
            (async () => {
              await runCommand(["afplay", soundPath])
            })()
          )
        }
      }
    }

    await Promise.all(tasks)
  }

  const notifyLinux = async (message: string, title: string, sound: string): Promise<void> => {
    const tasks: Promise<unknown>[] = [
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

  const notify = async (message: string, title: string = "OpenCode", sound: string = "Glass"): Promise<void> => {
    if (!isSupported) return

    if (isMacOS) {
      await notifyMacOS(message, title, sound)
    } else if (isLinux) {
      await notifyLinux(message, title, sound)
    }
  }

  const recentNotifications = new Map<string, number>()

  const shouldNotify = (key: string): boolean => {
    const now = Date.now()
    const windowMs = CONFIG.dedupeWindowMs
    const maxEntries = CONFIG.maxRecentNotifications
    const expiredKeys: string[] = []
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

  const toSummary = (event: PluginEvent): string => {
    if (!event || typeof event !== "object") return "unknown operation"
    const props      = (event.properties ?? {}) as PermissionEventProperties
    const permission = props.permission ?? ""
    const meta       = (props.metadata ?? {}) as Record<string, unknown>

    switch (permission) {
      case "external_directory": {
        const path = (meta.filepath ?? meta.parentDir ?? (props.patterns ?? [])[0] ?? "") as string
        const name = extractFilename(path)
        return name ? `access: ${name}` : path ? `access: ${path}` : "access external file"
      }
      case "network": {
        const url = (meta.url ?? meta.host ?? "") as string
        return url ? `network request: ${url}` : "make a network request"
      }
      case "shell": {
        const cmd    = (meta.command ?? meta.cmd ?? "") as string
        const tokens = String(cmd).trim().split(/\s+/).slice(0, 5)
        return tokens.length ? `run: ${tokens.join(" ")}` : "run a shell command"
      }
      default: {
        const label = permission ? permission.replace(/_/g, " ") : "external operation"
        const path  = (meta.filepath ?? meta.parentDir ?? "") as string
        const name  = extractFilename(path)
        return name ? `${label}: ${name}` : label
      }
    }
  }

  const handleNotificationEvent = async (eventType: string, configKey: keyof NotificationEventConfig, extraLog: string = ""): Promise<boolean> => {
    if (!CONFIG.events[configKey]) return false
    const focused = await isTerminalFocused()
    log(`${eventType} | terminalProcessName=${terminalProcessName} | focused=${focused}${extraLog}`)
    if (focused) return false
    await notify(CONFIG.messages[configKey], "OpenCode", CONFIG.sounds[configKey])
    return true
  }

  // Subagents create child sessions with parentID. Track them so we can
  // suppress "Task completed!" notifications when only a subagent finishes.
  const subagentSessionIds = new Set<string>()
  const trackedSessionIds = new Map<string, TrackedSession>()
  const erroredSessionIds = new Set<string>()
  const idleNotifiedSessionIds = new Set<string>()

  const MAX_SESSION_SET_SIZE = CONFIG.maxRecentNotifications
  const trimSet = (set: Set<string>): void => {
    if (set.size > MAX_SESSION_SET_SIZE) {
      const toRemove = set.size - MAX_SESSION_SET_SIZE
      const iter = set.values()
      for (let i = 0; i < toRemove; i++) set.delete(iter.next().value!)
    }
  }

  return {
    event: async ({ event }: { event: PluginEvent }) => {
      if (!isSupported) return

      if (event.type.startsWith("session.")) {
        log(`EVENT ${event.type} | props=${JSON.stringify(event.properties ?? {})}`)
      }

      if (event.type === "session.created" || event.type === "session.updated") {
        const props = event.properties as SessionEventProperties | undefined
        const info = props?.info
        const sid = props?.sessionID
        if (sid && info) {
          trackedSessionIds.set(sid, { parentID: info.parentID, title: info.title })
          if (info.parentID) {
            subagentSessionIds.add(sid)
            trimSet(subagentSessionIds)
            log(`TRACKED subagent session=${sid} parentID=${info.parentID} title=${info.title}`)
          } else {
            log(`TRACKED main session=${sid} title=${info.title}`)
          }
        }
        return
      }

      if (event.type === "session.idle") {
        const props = event.properties as SessionEventProperties | undefined
        const sessionID = props?.sessionID
        const isSubagent = sessionID && subagentSessionIds.has(sessionID)
        log(`session.idle | session=${sessionID} | isSubagent=${isSubagent} | tracked=${JSON.stringify(Object.fromEntries(trackedSessionIds))}`)
        if (isSubagent) {
          log(`session.idle | SKIPPED subagent notification for session=${sessionID}`)
          subagentSessionIds.delete(sessionID)
          trackedSessionIds.delete(sessionID)
          return
        }
        if (sessionID && erroredSessionIds.has(sessionID)) {
          log(`session.idle | SKIPPED idle after error for session=${sessionID}`)
          erroredSessionIds.delete(sessionID)
          return
        }
        if (sessionID && idleNotifiedSessionIds.has(sessionID)) {
          log(`session.idle | SKIPPED duplicate idle for session=${sessionID}`)
          return
        }
        if (sessionID) {
          idleNotifiedSessionIds.add(sessionID)
          trimSet(idleNotifiedSessionIds)
        }
        log(`session.idle | SENDING main agent notification for session=${sessionID}`)
        await handleNotificationEvent("session.idle", "idle")
        return
      }

      if (event.type === "session.deleted") {
        const props = event.properties as SessionEventProperties | undefined
        const sessionID = props?.sessionID
        if (sessionID) {
          subagentSessionIds.delete(sessionID)
          trackedSessionIds.delete(sessionID)
          erroredSessionIds.delete(sessionID)
          idleNotifiedSessionIds.delete(sessionID)
        }
        return
      }

      if (event.type === "session.error") {
        const props = event.properties as SessionEventProperties | undefined
        const sessionID = props?.sessionID
        if (sessionID) {
          subagentSessionIds.delete(sessionID)
          erroredSessionIds.add(sessionID)
          trimSet(erroredSessionIds)
        }
        await handleNotificationEvent("session.error", "error")
        return
      }

      if (event.type === "permission.asked" || event.type === "permission.updated") {
        if (!CONFIG.events.permission) return
        const focused = await isTerminalFocused()
        const props = (event.properties ?? {}) as PermissionEventProperties
        const permType = props.permission ?? "unknown"
        log(`${event.type} | focused=${focused} | permType=${permType}`)
        if (focused) return
        if (!shouldNotify(`permission:${permType}`)) return
        const summary = toSummary(event)
        const message = CONFIG.messages.permission.replace("{summary}", summary)
        await notify(message, "OpenCode", CONFIG.sounds.permission)
        return
      }
    },

    "tool.execute.before": async (input: ToolExecuteInput) => {
      if (!isSupported) return
      const toolName = typeof input?.tool === "string" ? input.tool : ""
      log(`tool.execute.before | tool=${JSON.stringify(toolName)} | input keys=${Object.keys(input ?? {}).join(",")}`)
      if (toolName.toLowerCase() !== "question") return
      if (!CONFIG.events.question) return
      if (!shouldNotify("question")) return
      const focused = await isTerminalFocused()
      log(`tool.execute.before(question) | terminalProcessName=${terminalProcessName} | focused=${focused}`)
      if (focused) return
      await notify(CONFIG.messages.question, "OpenCode", CONFIG.sounds.question)
    },

    "tool.execute.after": async (input: ToolExecuteInput) => {
      if (!isSupported) return
      const toolName = typeof input?.tool === "string" ? input.tool : ""
      log(`tool.execute.after | tool=${JSON.stringify(toolName)}`)
    },
  }
}
