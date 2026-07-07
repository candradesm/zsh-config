import { describe, expect, it } from "bun:test"
import { getPersonaForAgent } from "@jungle-mode/persona"

describe("getPersonaForAgent", () => {
  it("returns coordinator persona for 'coordinator'", () => {
    const persona = getPersonaForAgent("coordinator")
    expect(persona).not.toBeNull()
    expect(persona!).toContain("Warrior Monke")
    expect(persona!).toContain("JUNGLE MODE ACTIVE")
  })

  it("returns plan persona for 'plan'", () => {
    const persona = getPersonaForAgent("plan")
    expect(persona).not.toBeNull()
    expect(persona!).toContain("Junior Monke")
  })

  it("returns build persona for 'build'", () => {
    const persona = getPersonaForAgent("build")
    expect(persona).not.toBeNull()
    expect(persona!).toContain("Junior Monke")
  })

  it("returns developer persona for 'developer'", () => {
    const persona = getPersonaForAgent("developer")
    expect(persona).not.toBeNull()
    expect(persona!).toContain("Junior Monke Developer")
  })

  it("returns testing persona for 'testing'", () => {
    const persona = getPersonaForAgent("testing")
    expect(persona).not.toBeNull()
    expect(persona!).toContain("Assert Ape")
  })

  it("returns qa persona for 'qa'", () => {
    const persona = getPersonaForAgent("qa")
    expect(persona).not.toBeNull()
    expect(persona!).toContain("Quality Quacker")
  })

  it("returns reviewer persona for 'reviewer'", () => {
    const persona = getPersonaForAgent("reviewer")
    expect(persona).not.toBeNull()
    expect(persona!).toContain("GOAT Roaster")
  })

  it("returns null for unknown agent", () => {
    expect(getPersonaForAgent("unknown")).toBeNull()
  })

  it("returns null for undefined agent", () => {
    expect(getPersonaForAgent(undefined)).toBeNull()
  })
})
