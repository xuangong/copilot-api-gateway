import { test, expect } from 'bun:test'
import { Marked } from 'marked'
import { cjkStrong } from './cjk-emphasis'

// A private instance rather than the `marked` singleton: markdown.ts configures
// that one at import time, and this keeps the test from depending on load order
// (or on DOMPurify, which wants a DOM that bun test has no reason to provide).
const md = new Marked({ gfm: true, breaks: true }).use({ extensions: [cjkStrong] })
const render = (src: string) => md.parse(src, { async: false }) as string

test('bold survives a CJK full stop followed immediately by more text', () => {
  // The three cases from the bug report, verbatim. Each closes on `。` and runs
  // straight into a non-space character, which is exactly what CommonMark's
  // right-flanking rule rejects.
  expect(render('**改写确实有效，且跨模型通用。**TikTok/UMD 的工作显示')).toContain(
    '<strong>改写确实有效，且跨模型通用。</strong>TikTok',
  )
  expect(render('**效果随改写用的 LLM 规模上升。**该论文专门做了')).toContain(
    '<strong>效果随改写用的 LLM 规模上升。</strong>该论文',
  )
  expect(render('**更强的 MLLM 在复杂 prompt 上优势更明显。**微软的 TIR 工作')).toContain(
    '<strong>更强的 MLLM 在复杂 prompt 上优势更明显。</strong>微软',
  )
})

test('a closer preceded by a colon is claimed too', () => {
  expect(render('**最关键的一条，直接回答你的问题：**效果随规模上升')).toContain(
    '<strong>最关键的一条，直接回答你的问题：</strong>效果',
  )
})

test('the cases that already worked keep working', () => {
  // Closer preceded by a letter — valid under the flanking rule all along.
  expect(render('**看图纠错**。TIR 的做法是')).toContain('<strong>看图纠错</strong>。TIR')
  expect(render('**纯中文加粗**')).toContain('<strong>纯中文加粗</strong>')
  expect(render('**bold**next')).toContain('<strong>bold</strong>next')
})

test('pure-ASCII spans are left to marked, including the non-emphasis ones', () => {
  // CommonMark is right here and we must not "fix" it: this is exponentiation,
  // not two bold markers.
  const html = render('2 ** 3 ** 4')
  expect(html).not.toContain('<strong>')
  expect(html).toContain('**')
})

test('padded delimiters are not emphasis, CJK or not', () => {
  expect(render('** 中文 **')).not.toContain('<strong>')
})

test('inline markup inside a claimed span still renders', () => {
  expect(render('**看 `code` 的效果。**后续')).toContain('<code>code</code>')
})

test('a code span containing the pattern is not reinterpreted', () => {
  const html = render('`**中文。**x`')
  expect(html).toContain('<code>')
  expect(html).not.toContain('<strong>')
})
