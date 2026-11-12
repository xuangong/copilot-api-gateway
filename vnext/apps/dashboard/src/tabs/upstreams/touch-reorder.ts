import { useCallback, useEffect, useMemo, useRef, type PointerEvent as ReactPointerEvent } from "react"

/** How far (px) a finger travels on the handle before it is a drag rather than a tap. */
const SLOP = 6
/** Distance (px) from the scroller's top or bottom edge where a drag scrolls it. */
const EDGE = 48
/** Fastest auto-scroll, px per frame. */
const MAX_SPEED = 14

/**
 * Pixels to scroll this frame for a finger at `y`: up (negative) within `edge`
 * of the top, down within `edge` of the bottom, faster the closer it gets.
 */
export function edgeScrollDelta(y: number, top: number, bottom: number, edge = EDGE, max = MAX_SPEED): number {
  if (y < top + edge) return -Math.ceil(max * Math.min(1, (top + edge - y) / edge))
  if (y > bottom - edge) return Math.ceil(max * Math.min(1, (y - (bottom - edge)) / edge))
  return 0
}

export interface TouchReorderHandlers {
  /** The finger moved far enough: a drag of `sourceId` begins. */
  start: (sourceId: string) => void
  /** The finger is over row `targetId`; return whether that row takes the drop. */
  over: (sourceId: string, targetId: string) => boolean
  /** The finger lifted; `targetId` is the last row that took the drop, or null. */
  drop: (sourceId: string, targetId: string | null) => void
  /** A drag that had begun ended without a drop (pointercancel, abort). */
  cancel: () => void
}

/** The fields of a pointer or drag event a gesture reads. */
export interface GestureEvent {
  type: string
  pointerId?: number
  clientX?: number
  clientY?: number
}

/** What a gesture needs from the page; tests pass fakes. */
export interface GestureDeps {
  /** Where pointer and drag events arrive: the window. */
  events: {
    addEventListener(type: string, listener: (event: GestureEvent) => void): void
    removeEventListener(type: string, listener: (event: GestureEvent) => void): void
  }
  /** Id of the row under the point, or null. */
  rowAt: (x: number, y: number) => string | null
  /** Scrolls if `y` is near the scroller's edge; returns whether it scrolled. */
  autoScroll: (y: number) => boolean
  requestFrame: (callback: () => void) => number
  cancelFrame: (handle: number) => void
}

/**
 * Follows one touch or pen press on a drag handle until it ends, reporting to
 * `handlers`. The drop target is tracked here rather than read back from React
 * state, which renders after the window listeners run: a quick flick can lift
 * before the drag it started has rendered.
 *
 * Returns abort(): it ends the gesture and reports a cancel if a drag had
 * begun. After the gesture has ended it does nothing.
 */
export function trackTouchReorder(
  press: { pointerId: number; clientX: number; clientY: number },
  sourceId: string,
  handlers: TouchReorderHandlers,
  deps: GestureDeps,
): () => void {
  let x = press.clientX
  let y = press.clientY
  let dragging = false
  let ended = false
  let target: string | null = null
  let frame = 0

  const hover = () => {
    const id = deps.rowAt(x, y)
    if (id && id !== sourceId && handlers.over(sourceId, id)) target = id
  }
  const tick = () => {
    if (deps.autoScroll(y)) hover()
    frame = deps.requestFrame(tick)
  }
  const move = (event: GestureEvent) => {
    if (event.pointerId !== press.pointerId) return
    x = event.clientX ?? x
    y = event.clientY ?? y
    if (!dragging) {
      if (Math.hypot(x - press.clientX, y - press.clientY) < SLOP) return
      dragging = true
      handlers.start(sourceId)
      frame = deps.requestFrame(tick)
    }
    hover()
  }
  const finish = (event: GestureEvent) => {
    if (event.pointerId !== press.pointerId) return
    end()
    if (!dragging) return
    if (event.type === "pointerup") handlers.drop(sourceId, target)
    else handlers.cancel()
  }
  // The browser started its own drag on the draggable handle (Chrome does for
  // a pen, iPadOS for a long press). The handle's native drag handlers own the
  // drag from here, and this pointer may never report up or cancel; let go.
  const yieldToNativeDrag = () => end()

  const listeners: Array<[string, (event: GestureEvent) => void]> = [
    ["pointermove", move],
    ["pointerup", finish],
    ["pointercancel", finish],
    ["dragstart", yieldToNativeDrag],
  ]
  function end() {
    ended = true
    deps.cancelFrame(frame)
    for (const [type, listener] of listeners) deps.events.removeEventListener(type, listener)
  }
  for (const [type, listener] of listeners) deps.events.addEventListener(type, listener)

  return () => {
    if (ended) return
    end()
    if (dragging) handlers.cancel()
  }
}

/** The element that scrolls `node` vertically: the nearest scrolling ancestor, else the page. */
function scrollParent(node: HTMLElement): HTMLElement {
  for (let el = node.parentElement; el; el = el.parentElement) {
    const { overflowY } = getComputedStyle(el)
    if ((overflowY === "auto" || overflowY === "scroll") && el.scrollHeight > el.clientHeight) return el
  }
  return document.scrollingElement instanceof HTMLElement ? document.scrollingElement : document.documentElement
}

/**
 * Drag-to-reorder for touch and pen. The handle's native drag (draggable) is
 * what a mouse uses, and most touch browsers never start it, so for other
 * pointers this follows the finger: the row under it is found by
 * `data-upstream-id`, and the scroller scrolls while the finger is near its top
 * or bottom edge. Listeners sit on window, not on the handle: the handle's row
 * moves in the DOM as the preview reorders, which can drop pointer capture.
 *
 * Lifting the finger anywhere drops on the last row it was over, which is what
 * the preview shows; a mouse drag released between rows drops nothing.
 * `abort` ends a gesture in progress (Esc), reporting a cancel.
 */
export function useTouchReorder(handlers: TouchReorderHandlers) {
  const latest = useRef(handlers)
  latest.current = handlers
  const abortGesture = useRef<(() => void) | null>(null)
  const abort = useCallback(() => abortGesture.current?.(), [])
  useEffect(() => abort, [abort])

  const begin = useCallback((event: ReactPointerEvent<HTMLElement>, sourceId: string) => {
    if (event.pointerType === "mouse" || !event.isPrimary) return
    abortGesture.current?.()
    const scroller = scrollParent(event.currentTarget)
    const page = scroller === document.scrollingElement || scroller === document.documentElement
    abortGesture.current = trackTouchReorder(event, sourceId, {
      start: (id) => latest.current.start(id),
      over: (id, targetId) => latest.current.over(id, targetId),
      drop: (id, targetId) => latest.current.drop(id, targetId),
      cancel: () => latest.current.cancel(),
    }, {
      events: window,
      rowAt: (x, y) => document.elementFromPoint(x, y)?.closest<HTMLElement>("[data-upstream-id]")?.dataset.upstreamId ?? null,
      autoScroll: (y) => {
        const { top, bottom } = page ? { top: 0, bottom: window.innerHeight } : scroller.getBoundingClientRect()
        const delta = edgeScrollDelta(y, top, bottom)
        if (delta !== 0) scroller.scrollBy(0, delta)
        return delta !== 0
      },
      requestFrame: (callback) => requestAnimationFrame(callback),
      cancelFrame: (handle) => cancelAnimationFrame(handle),
    })
  }, [])

  return useMemo(() => ({ begin, abort }), [begin, abort])
}
