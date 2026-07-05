export interface LoadGuard {
  /** Invalidate the current generation — call before starting a new fetch.
   *  Returns the new generation number (pass it to isCurrent() to check later). */
  invalidate: () => number
  /** Check whether a stored generation is still current. */
  isCurrent: (gen: number) => boolean
}

export function createLoadGuard(): LoadGuard {
  let generation = 0

  return {
    invalidate(): number {
      generation++
      return generation
    },
    isCurrent(gen: number): boolean {
      return gen === generation
    },
  }
}
