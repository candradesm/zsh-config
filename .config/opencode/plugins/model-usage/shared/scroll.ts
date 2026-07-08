export interface ScrollState {
  scrollRef: any
  isScrolled: () => boolean
  isAtBottom: () => boolean
  hasOverflow: () => boolean
  handleUp: () => boolean
  handleDown: () => boolean
  handlePageUp: () => boolean
  handlePageDown: () => boolean
  checkOverflow: () => void
  scrollToTop: () => void
}

export function makeScrollState(
  createSignal: <T>(value: T) => [() => T, (value: T) => void]
): ScrollState {
  let scrollRef: any = null
  const [isScrolled, setIsScrolled] = createSignal(false)
  const [isAtBottom, setIsAtBottom] = createSignal(false)
  const [hasOverflow, setHasOverflow] = createSignal(false)

  function checkOverflow() {
    const sh = scrollRef?.scrollHeight ?? 0
    const ch = scrollRef?.clientHeight ?? scrollRef?.height ?? 40
    setHasOverflow(sh > ch + 2)
  }

  function handleUp(): boolean {
    scrollRef?.scrollBy?.(-10)
    setIsAtBottom(false)
    setTimeout(() => {
      const top = scrollRef?.scrollTop ?? 0
      if (top <= 0) setIsScrolled(false)
      checkOverflow()
    }, 50)
    return true
  }

  function handleDown(): boolean {
    scrollRef?.scrollBy?.(10)
    setIsScrolled(true)
    setTimeout(() => {
      const st = scrollRef?.scrollTop ?? 0
      const ch = scrollRef?.clientHeight ?? scrollRef?.height ?? 40
      const sh = scrollRef?.scrollHeight ?? 0
      setIsAtBottom(st + ch >= sh - 5)
      checkOverflow()
    }, 50)
    return true
  }

  function handlePageUp(): boolean {
    const el = scrollRef
    if (!el || typeof el.scrollBy !== "function") return false
    const ch = el.clientHeight ?? el.height ?? 40
    const pageSize = Math.max(1, ch - 2)
    el.scrollBy(0, -pageSize)
    setIsAtBottom(false)
    setTimeout(() => {
        const top = scrollRef?.scrollTop ?? 0
        if (top <= 0) setIsScrolled(false)
        checkOverflow()
    }, 50)
    return true
  }

  function handlePageDown(): boolean {
    const el = scrollRef
    if (!el || typeof el.scrollBy !== "function") return false
    const ch = el.clientHeight ?? el.height ?? 40
    const pageSize = Math.max(1, ch - 2)
    el.scrollBy(0, pageSize)
    setIsScrolled(true)
    setTimeout(() => {
        const st = scrollRef?.scrollTop ?? 0
        const ch2 = scrollRef?.clientHeight ?? scrollRef?.height ?? 40
        const sh = scrollRef?.scrollHeight ?? 0
        setIsAtBottom(st + ch2 >= sh - 5)
        checkOverflow()
    }, 50)
    return true
  }

  function scrollToTop() {
    if (scrollRef?.scrollTo) {
      try { scrollRef.scrollTo(0) } catch { /* ignore */ }
    }
    setIsScrolled(false)
    setIsAtBottom(false)
  }

  return {
    get scrollRef() { return scrollRef },
    set scrollRef(v: any) { scrollRef = v },
    isScrolled,
    isAtBottom,
    hasOverflow,
    handleUp,
    handleDown,
    handlePageUp,
    handlePageDown,
    checkOverflow,
    scrollToTop,
  }
}
