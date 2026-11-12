import { expect, test } from "bun:test"
import { outlineLevels, renderMarkdown } from "./markdown"

// DOMPurify has no `sanitize` outside a browser; these tests are about our markup.
const passThrough = (html: string) => html

test("outlineLevels starts a reply at h2 and never skips a level", () => {
  expect(outlineLevels([])).toEqual([])
  expect(outlineLevels([1, 2, 2, 1])).toEqual([2, 3, 3, 2])
  expect(outlineLevels([2, 3])).toEqual([2, 3])
  expect(outlineLevels([1, 3])).toEqual([2, 3])
  expect(outlineLevels([3, 1])).toEqual([2, 2])
  expect(outlineLevels([1, 2, 3, 4, 5, 6])).toEqual([2, 3, 4, 5, 6, 6])
})

test("reply headings take their outline level and keep their markdown size", () => {
  const html = renderMarkdown("# Title\n\n### Detail\n\ntext", passThrough)
  expect(html).toContain('<h2 class="md-h1">Title</h2>')
  expect(html).toContain('<h3 class="md-h3">Detail</h3>')
  expect(html).not.toContain("<h1")
})

test("headings inside lists count too, and CJK bold still renders", () => {
  const html = renderMarkdown("## A\n\n- #### B\n\n**加粗。**后接文字", passThrough)
  expect(html).toContain('<h2 class="md-h2">A</h2>')
  expect(html).toContain('<h3 class="md-h4">B</h3>')
  expect(html).toContain("<strong>加粗。</strong>后接文字")
})
