import { describe, expect, it, beforeAll, afterAll } from "bun:test"
import { resolveClipboardCandidates, buildOsc52Sequence } from "@model-usage/helpers/clipboard"

// ─── resolveClipboardCandidates ──────────────────────────────────────────────

describe("resolveClipboardCandidates", () => {
  it("returns correct candidates for darwin", () => {
    const res = resolveClipboardCandidates("darwin")
    expect(res).toEqual([
      { cmd: "pbcopy", args: [] },
      { cmd: "osascript", args: ["-e", "set the clipboard to (read \"/dev/stdin\" as «class utf8»)" ] }
    ])
  })

  it("returns correct candidates for linux", () => {
    const res = resolveClipboardCandidates("linux")
    expect(res).toEqual([
      { cmd: "wl-copy", args: [] },
      { cmd: "xclip", args: ["-selection", "clipboard"] },
      { cmd: "xsel", args: ["--clipboard", "--input"] }
    ])
  })

  it("returns correct candidates for win32", () => {
    const res = resolveClipboardCandidates("win32")
    expect(res).toEqual([
      {
        cmd: "powershell.exe",
        args: [
          "-NonInteractive",
          "-NoProfile",
          "-Command",
          "[Console]::InputEncoding = [System.Text.Encoding]::UTF8; Set-Clipboard -Value ([Console]::In.ReadToEnd())"
        ]
      }
    ])
  })

  it("returns empty array for unrecognized platforms", () => {
    expect(resolveClipboardCandidates("freebsd")).toEqual([])
    expect(resolveClipboardCandidates("sunos")).toEqual([])
    expect(resolveClipboardCandidates("openbsd")).toEqual([])
  })
})

// ─── buildOsc52Sequence ───────────────────────────────────────────────────────

describe("buildOsc52Sequence", () => {
  const originalTmux = process.env.TMUX
  const originalSty = process.env.STY

  it("produces expected OSC 52 sequence without TMUX or STY", () => {
    delete process.env.TMUX
    delete process.env.STY

    const text = "hello monke"
    const base64 = Buffer.from(text).toString("base64")
    const res = buildOsc52Sequence(text)
    expect(res).toBe(`\x1b]52;c;${base64}\x07`)

    // Restore env variables
    if (originalTmux) process.env.TMUX = originalTmux
    if (originalSty) process.env.STY = originalSty
  })

  it("produces expected wrapped sequence with TMUX", () => {
    process.env.TMUX = "1"
    delete process.env.STY

    const text = "hello tmux"
    const base64 = Buffer.from(text).toString("base64")
    const res = buildOsc52Sequence(text)
    const expectedInner = `\x1b]52;c;${base64}\x07`
    expect(res).toBe(`\x1bPtmux;\x1b${expectedInner}\x1b\\`)

    // Restore env variables
    if (originalTmux) {
      process.env.TMUX = originalTmux
    } else {
      delete process.env.TMUX
    }
    if (originalSty) process.env.STY = originalSty
  })

  it("produces expected wrapped sequence with STY", () => {
    delete process.env.TMUX
    process.env.STY = "1"

    const text = "hello sty"
    const base64 = Buffer.from(text).toString("base64")
    const res = buildOsc52Sequence(text)
    const expectedInner = `\x1b]52;c;${base64}\x07`
    expect(res).toBe(`\x1bPtmux;\x1b${expectedInner}\x1b\\`)

    // Restore env variables
    if (originalTmux) process.env.TMUX = originalTmux
    if (originalSty) {
      process.env.STY = originalSty
    } else {
      delete process.env.STY
    }
  })

  it("handles empty string", () => {
    delete process.env.TMUX
    delete process.env.STY

    const res = buildOsc52Sequence("")
    expect(res).toBe(`\x1b]52;c;\x07`)

    // Restore env variables
    if (originalTmux) process.env.TMUX = originalTmux
    if (originalSty) process.env.STY = originalSty
  })

  it("handles unicode and multi-byte text input without throwing", () => {
    delete process.env.TMUX
    delete process.env.STY

    const text = "🍌 Monke Valhalla 🦧"
    const base64 = Buffer.from(text).toString("base64")
    const res = buildOsc52Sequence(text)
    expect(res).toBe(`\x1b]52;c;${base64}\x07`)

    // Restore env variables
    if (originalTmux) process.env.TMUX = originalTmux
    if (originalSty) process.env.STY = originalSty
  })
})

// ─── osascript clipboard round-trip (darwin only) ────────────────────────────

import { spawn } from "node:child_process"

function runCommand(cmd: string, args: string[], input?: string): Promise<{ stdout: string; code: number }> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: input !== undefined ? ["pipe", "pipe", "ignore"] : ["ignore", "pipe", "ignore"] })
    let stdout = ""
    child.stdout?.on("data", (chunk: Buffer) => { stdout += chunk.toString() })
    child.on("close", (code) => resolve({ stdout, code: code ?? -1 }))
    child.on("error", reject)
    if (input !== undefined && child.stdin) {
      child.stdin.write(input)
      child.stdin.end()
    }
  })
}

const platformDescribe = process.platform === "darwin" ? describe : describe.skip

platformDescribe("osascript clipboard round-trip (darwin only)", () => {
  let savedClipboard = ""

  beforeAll(async () => {
    // Check if osascript is available
    try {
      const { stdout } = await runCommand("osascript", ["-e", "the clipboard as text"])
      savedClipboard = stdout
    } catch {
      // osascript not available, test will be skipped
    }
  })

  it("writes and reads back clipboard content via osascript", async () => {
    const payload = "TEST_PAYLOAD_MODEL_USAGE_1234"

    // Write payload to clipboard using osascript with text passed as argument
    // (stdin-based read from /dev/stdin doesn't work on all macOS versions)
    const writeResult = await runCommand(
      "osascript",
      ["-e", `on run argv
  set the clipboard to (item 1 of argv)
end run`, payload]
    )
    expect(writeResult.code).toBe(0)

    // Read clipboard back
    const readResult = await runCommand("osascript", ["-e", "the clipboard as text"])
    expect(readResult.code).toBe(0)
    expect(readResult.stdout.trim()).toBe(payload)
  })

  afterAll(async () => {
    // Restore the original clipboard content
    try {
      await runCommand(
        "osascript",
        ["-e", `on run argv
  set the clipboard to (item 1 of argv)
end run`, savedClipboard]
      )
    } catch {
      // If restore fails, nothing we can do
    }
  })
})
