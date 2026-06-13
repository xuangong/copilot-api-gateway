const _resets = new Set<() => void>()

export function __registerPlatformReset(fn: () => void): void {
  _resets.add(fn)
}

export function __resetPlatformForTests(): void {
  for (const fn of _resets) fn()
}
