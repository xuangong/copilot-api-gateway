// vnext/apps/dashboard/src/tabs/models/cjk-emphasis.ts
/**
 * `**加粗。**后接文字` renders literally under CommonMark. That is the spec
 * working as written, not a bug in marked: a closing `**` is only a closer if
 * the delimiter run is *right-flanking*, and when the run is preceded by a
 * punctuation character it additionally has to be followed by whitespace or
 * punctuation. Chinese text hits this constantly —
 *
 *     **改写确实有效，且跨模型通用。**TikTok/UMD 的工作显示
 *
 * closes on `。` and continues straight into `T`, so neither branch holds and
 * the whole span comes out as asterisks. `**看图纠错**。` works, because the
 * closer is preceded by a letter. The result is a page where some bold survives
 * and some doesn't, with no pattern a reader could guess.
 *
 * The upstream fix for this is to count CJK characters as punctuation when
 * deciding flanking (cmark-gfm did exactly that for GitHub). marked exposes no
 * hook into its flanking test, so this reaches the same place from the other
 * side: an inline extension that claims `**…**` spans *before* marked's own
 * emphasis tokenizer sees them.
 *
 * It deliberately claims as little as possible. Only spans whose content
 * actually contains a CJK character are taken over; everything else — including
 * `2 ** 3 ** 4`, which CommonMark correctly leaves alone — falls through to
 * marked untouched. Single-`*` emphasis is not handled: it has the same
 * flanking problem in theory, but a lone `*` next to CJK is far more often
 * arithmetic or a footnote marker than emphasis, and claiming it would trade a
 * visible bug for an invisible one.
 */
import type { TokenizerAndRendererExtension, Tokens } from 'marked'

/**
 * CJK ideographs, kana, and the full-width/CJK punctuation blocks. The
 * punctuation blocks matter as much as the ideographs: `。` and `：` are what
 * put the closing delimiter in the losing branch of the flanking rule.
 */
const CJK = /[⺀-鿿豈-﫿︰-﹏＀-￯]/

/**
 * Non-greedy so it closes on the *nearest* `**`, and `\*(?!\*)` lets a single
 * asterisk live inside the span without ending it. `\n` is excluded: a span
 * that wraps across a line break stays marked's problem, which keeps this
 * extension from reinterpreting block structure.
 */
const STRONG = /^\*\*((?:[^*\n]|\*(?!\*))+?)\*\*/

export const cjkStrong: TokenizerAndRendererExtension = {
  name: 'cjkStrong',
  level: 'inline',

  start(src: string) {
    const i = src.indexOf('**')
    return i < 0 ? undefined : i
  },

  tokenizer(src: string) {
    const m = STRONG.exec(src)
    if (!m) return undefined
    const text = m[1]!
    // Pure-ASCII spans are not what this exists for, and marked already gets
    // them right — including the cases where the answer is "not emphasis".
    if (!CJK.test(text)) return undefined
    // `** x **` is not emphasis under CommonMark either; don't invent it.
    if (/^\s|\s$/.test(text)) return undefined
    return {
      type: 'cjkStrong',
      raw: m[0],
      text,
      tokens: this.lexer.inlineTokens(text),
    }
  },

  renderer(token: Tokens.Generic) {
    return `<strong>${this.parser.parseInline(token.tokens ?? [])}</strong>`
  },
}
