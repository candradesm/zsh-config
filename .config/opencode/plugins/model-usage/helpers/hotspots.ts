/**
 * Hotspots helper module.
 * Utilities to compute statistical medians and detect token usage hotspots across categories.
 */

// ─── Types ───────────────────────────────────────────────────────────────────

export interface HotspotCandidate {
  category: string
  label: string
  tokens: number
  preview: string
  fullText: string
}

export interface HotspotResult extends HotspotCandidate {
  ratio: number
}

// ─── Statistics ──────────────────────────────────────────────────────────────

/**
 * Computes the standard statistical median of an array of numbers.
 * For even-length arrays, averages the two middle values.
 * Returns 0 for empty input.
 */
export function median(nums: readonly number[]): number {
  if (nums.length === 0) return 0
  const sorted = [...nums].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  if (sorted.length % 2 !== 0) {
    return sorted[mid]
  }
  return (sorted[mid - 1] + sorted[mid]) / 2
}

// ─── Hotspot Detection ───────────────────────────────────────────────────────

/**
 * Detects token usage hotspots across categories.
 * For each category, computes the median token count across all its candidates.
 * Candidates with tokens > median * multiplier (default 2) where median > 0 are
 * considered hotspots with ratio = tokens / median.
 * 
 * Merges results across all categories, sorts by ratio descending, and returns
 * at most `cap` (default 5) results.
 */
export function detectHotspots(
  categoryCandidates: Record<string, readonly HotspotCandidate[]>,
  options?: { multiplier?: number; cap?: number }
): HotspotResult[] {
  const multiplier = options?.multiplier ?? 2
  const cap = options?.cap ?? 5

  const results: HotspotResult[] = []

  for (const [_, candidates] of Object.entries(categoryCandidates)) {
    if (!candidates || candidates.length === 0) continue

    const tokensList = candidates.map((c) => c.tokens)
    const categoryMedian = median(tokensList)

    if (categoryMedian <= 0) continue

    const threshold = categoryMedian * multiplier
    for (const candidate of candidates) {
      if (candidate.tokens > threshold) {
        results.push({
          ...candidate,
          ratio: candidate.tokens / categoryMedian,
        })
      }
    }
  }

  // Sort by ratio descending
  results.sort((a, b) => b.ratio - a.ratio)

  // Return at most cap results
  return results.slice(0, cap)
}

/**
 * Picks the best preview text for a hotspot candidate: prefers a non-empty
 * `title` (a human-readable summary some tools provide, e.g. a file path or
 * short description) over raw content, truncating to `maxLen` (default 70)
 * characters with an ellipsis if it overflows. Falls back to a trimmed
 * prefix of `fallbackText` when `title` is missing/empty.
 */
export function pickPreview(fallbackText: string, title?: string, maxLen = 70): string {
  const chosen = (title && title.trim().length > 0) ? title : fallbackText
  const trimmed = chosen.trim()
  if (trimmed.length > maxLen) {
    return trimmed.slice(0, maxLen - 1) + "…"
  }
  return trimmed
}

/**
 * Inspects a tool call's structured input arguments for a known, human-meaningful
 * field, checked in this exact priority order: "filePath", "path", "pattern",
 * "command", "url", "description", "prompt". Returns the first string-typed value
 * found among these keys, or null if none match (or input is missing/not an object).
 */
export function summarizeToolInput(
  toolName: string,
  input: Record<string, unknown> | undefined | null
): string | null {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return null
  }
  const priorityKeys = ["filePath", "path", "pattern", "command", "url", "description", "prompt"]
  for (const key of priorityKeys) {
    const value = input[key]
    if (typeof value === "string") {
      return value
    }
  }
  return null
}

/**
 * Shortens a path-like string to its last `segments` path components (default 2),
 * prefixed with "…/" when truncated. Handles both "/" and "\\" separators. If the
 * string has `segments` or fewer components already, returns it unchanged (no prefix
 * added). Safe to call on non-path strings too (if there's nothing meaningful to
 * shorten — e.g. no separators at all — return the input unchanged).
 */
export function shortenPath(path: string, segments = 2): string {
  const hasSlash = path.includes("/")
  const hasBackslash = path.includes("\\")
  if (!hasSlash && !hasBackslash) {
    return path
  }

  const parts = path.split(/[\/\\]/).filter(Boolean)
  if (parts.length <= segments) {
    return path
  }

  const lastParts = parts.slice(-segments)
  const sep = (hasBackslash && !hasSlash) ? "\\" : "/"
  const prefix = sep === "\\" ? "…\\" : "…/"
  return prefix + lastParts.join(sep)
}
