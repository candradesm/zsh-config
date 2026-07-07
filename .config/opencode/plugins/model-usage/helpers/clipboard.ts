/**
 * Clipboard helper module.
 * Standalone utility to write text to system clipboard via native commands or OSC 52 sequence.
 */

import { spawn } from "node:child_process"
import * as process from "node:process"

// ─── Types ───────────────────────────────────────────────────────────────────

export interface ClipboardCommand {
  cmd: string
  args: string[]
}

// ─── Candidates ───────────────────────────────────────────────────────────────

/**
 * Pure: returns an ordered list of candidate shell commands to try for the given platform.
 * No existence-checking here (that's the caller's job) — just the platform-appropriate list,
 * in priority order. Empty array for unrecognized platforms (forces OSC52-only fallback).
 */
export function resolveClipboardCandidates(platform: NodeJS.Platform): ClipboardCommand[] {
  if (platform === "darwin") {
    return [
      { cmd: "pbcopy", args: [] },
      { cmd: "osascript", args: ["-e", "set the clipboard to (read \"/dev/stdin\" as «class utf8»)" ] }
    ]
  }
  if (platform === "linux") {
    return [
      { cmd: "wl-copy", args: [] },
      { cmd: "xclip", args: ["-selection", "clipboard"] },
      { cmd: "xsel", args: ["--clipboard", "--input"] }
    ]
  }
  if (platform === "win32") {
    return [
      {
        cmd: "powershell.exe",
        args: [
          "-NonInteractive",
          "-NoProfile",
          "-Command",
          "[Console]::InputEncoding = [System.Text.Encoding]::UTF8; Set-Clipboard -Value ([Console]::In.ReadToEnd())"
        ]
      }
    ]
  }
  return []
}

// ─── OSC 52 Formatting ────────────────────────────────────────────────────────

/**
 * Builds the OSC 52 escape sequence. Format follows OpenCode's packages/tui/src/clipboard.ts
 * for the escape sequence itself (base64, 'c' target, BEL terminator, tmux/screen wrapping).
 * The darwin native path (pbcopy preferred, stdin-based osascript fallback) and OSC 52
 * timing (fallback-only, not fired-first) are intentional divergences.
 */
export function buildOsc52Sequence(text: string): string {
  const sequence = `\x1b]52;c;${Buffer.from(text).toString("base64")}\x07`
  return process.env.TMUX || process.env.STY ? `\x1bPtmux;\x1b${sequence}\x1b\\` : sequence
}

// ─── Execution ────────────────────────────────────────────────────────────────

/**
 * Executes a candidate clipboard command and writes the specified text to its stdin.
 * Returns true if command runs and exits with code 0, false otherwise.
 */
function tryCommand(cmd: string, args: string[], text: string): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    try {
      const child = spawn(cmd, args, { stdio: ["pipe", "ignore", "ignore"] })
      
      child.on("error", () => {
        resolve(false)
      })
      
      child.on("close", (code) => {
        resolve(code === 0)
      })
      
      if (child.stdin) {
        child.stdin.on("error", () => {
          // ignore stdin write errors
        })
        child.stdin.write(text)
        child.stdin.end()
      } else {
        resolve(false)
      }
    } catch {
      resolve(false)
    }
  })
}

/**
 * Impure orchestrator: tries each resolveClipboardCandidates(process.platform) command in order
 * (spawn, write `text` to stdin, wait for exit code 0 = success); on ALL failures, falls back to
 * writing buildOsc52Sequence(text) to process.stdout when isTTY (returns true, best-effort, can't
 * confirm OSC52 success). Returns false if native commands fail and stdout is not a TTY (OSC 52
 * would emit garbage).
 */
export async function writeClipboard(text: string): Promise<boolean> {
  try {
    const candidates = resolveClipboardCandidates(process.platform)
    for (const candidate of candidates) {
      const success = await tryCommand(candidate.cmd, candidate.args, text)
      if (success) {
        return true
      }
    }
    // Fallback to OSC 52
    if (process.stdout.isTTY) {
      const oscSequence = buildOsc52Sequence(text)
      process.stdout.write(oscSequence)
      return true
    }
    return false  // non-TTY, OSC 52 won't work
  } catch {
    return false
  }
}
