export function isSupportedModel(modelName: string): boolean {
  if (!modelName) return false
  const lower = modelName.toLowerCase()
  return lower.includes("copilot") || lower.includes("opencode-go")
}
