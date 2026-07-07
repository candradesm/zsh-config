import { describe, expect, it } from "bun:test"
import { resolveClipboardCandidates, buildOsc52Sequence } from "./clipboard"

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
