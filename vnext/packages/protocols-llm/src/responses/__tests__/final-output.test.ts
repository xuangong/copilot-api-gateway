import { expect, test } from 'bun:test'
import { ResponsesFinalOutput } from '../final-output'
import type { ResponsesOutputItem, ResponsesOutputMessage, ResponsesResult } from '../events'

const item = (id: string, text = id): ResponsesOutputMessage => ({ type: 'message', id, role: 'assistant', content: [{ type: 'output_text', text }] })
const result = (output: ResponsesOutputItem[]): ResponsesResult => ({ id: 'r', object: 'response', model: 'm', output, status: 'completed', error: null, incomplete_details: null })
test('closed items fill omitted terminal output in output-index order', () => {
  const fold = new ResponsesFinalOutput()
  fold.observe({ type: 'response.output_item.done', output_index: 2, item: item('c') })
  fold.observe({ type: 'response.output_item.done', output_index: 0, item: item('a') })
  expect(fold.complete(result([])).output).toEqual([item('a'), item('c')])
})
test('terminal values win by ID and terminal-only extras survive index collisions', () => {
  const fold = new ResponsesFinalOutput()
  fold.observe({ type: 'response.output_item.done', output_index: 0, item: item('a', 'old') })
  fold.observe({ type: 'response.output_item.done', output_index: 2, item: item('c') })
  expect(fold.complete(result([item('c', 'final'), item('extra')])).output).toEqual([item('a', 'old'), item('c', 'final'), item('extra')])
})
test('duplicate ID and index records have deterministic last-closed / final precedence', () => {
  const fold = new ResponsesFinalOutput()
  fold.observe({ type: 'response.output_item.done', output_index: 0, item: item('a') })
  fold.observe({ type: 'response.output_item.done', output_index: 1, item: item('a', 'closed') })
  fold.observe({ type: 'response.output_item.done', output_index: 1, item: item('b') })
  expect(fold.complete(result([item('b', 'final'), item('b', 'duplicate')])).output).toEqual([item('b', 'final')])
})
test('terminal-only output remains intact and unfinished deltas never overwrite final items', () => {
  const fold = new ResponsesFinalOutput()
  fold.observe({ type: 'response.output_item.added', output_index: 0, item: item('a', 'stale') })
  expect(fold.complete(result([item('a', 'final')])).output).toEqual([item('a', 'final')])
})
test('replacing and moving IDs does not leave a stale index during later terminal matching', () => {
  const fold = new ResponsesFinalOutput()
  fold.observe({ type: 'response.output_item.done', output_index: 0, item: item('a') })
  fold.observe({ type: 'response.output_item.done', output_index: 1, item: item('b') })
  fold.observe({ type: 'response.output_item.done', output_index: 1, item: item('a', 'moved') })
  fold.observe({ type: 'response.output_item.done', output_index: 1, item: item('c') })
  expect(fold.complete(result([item('a', 'terminal'), item('b', 'terminal')])).output).toEqual([
    item('c'), item('a', 'terminal'), item('b', 'terminal'),
  ])
})
test('a missing-ID positional replacement removes the previous identity only in that completion', () => {
  const fold = new ResponsesFinalOutput()
  fold.observe({ type: 'response.output_item.done', output_index: 0, item: item('a') })
  const anonymous = { ...item(''), id: undefined }
  expect(fold.complete(result([anonymous, item('a', 'terminal')])).output).toEqual([anonymous, item('a', 'terminal')])
  expect(fold.complete(result([])).output).toEqual([item('a')])
})
