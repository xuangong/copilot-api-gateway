import { test, expect } from 'bun:test'
import { distanceFromBottom, isAtBottom, STICK_TO_BOTTOM_SLACK_PX } from './scroll'

const metrics = (scrollTop: number, scrollHeight: number, clientHeight: number) =>
  ({ scrollTop, scrollHeight, clientHeight }) as never

test('distanceFromBottom is zero when scrolled all the way down', () => {
  expect(distanceFromBottom(metrics(1600, 2000, 400))).toBe(0)
  expect(distanceFromBottom(metrics(0, 2000, 400))).toBe(1600)
})

test('a thread shorter than its viewport counts as at the bottom', () => {
  // scrollHeight === clientHeight, scrollTop pinned at 0: the first delta of a
  // fresh conversation lands here, and it must still stick.
  expect(isAtBottom(metrics(0, 400, 400))).toBe(true)
})

test('fractional scrollTop still counts as at the bottom', () => {
  // Regression: an exact `=== scrollHeight - clientHeight` test never holds
  // under a non-integer devicePixelRatio, so the thread stopped following.
  expect(isAtBottom(metrics(1599.5, 2000, 400))).toBe(true)
})

test('a reader scrolled up is not at the bottom, and is not followed', () => {
  expect(isAtBottom(metrics(1600 - STICK_TO_BOTTOM_SLACK_PX - 1, 2000, 400))).toBe(false)
  expect(isAtBottom(metrics(0, 2000, 400))).toBe(false)
})

test('the slack boundary is inclusive', () => {
  expect(isAtBottom(metrics(1600 - STICK_TO_BOTTOM_SLACK_PX, 2000, 400))).toBe(true)
})
