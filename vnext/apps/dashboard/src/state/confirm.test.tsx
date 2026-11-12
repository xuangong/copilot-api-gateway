import { expect, test } from "bun:test"
import { readdirSync, readFileSync, statSync } from "node:fs"
import { join } from "node:path"
import { renderToStaticMarkup } from "react-dom/server"
import { ConfirmActions, ignoreEarlyYes, SETTLE_MS } from "../ui/confirm-dialog"
import { createAsker } from "./confirm"

const request = { title: "Delete?", confirmLabel: "Delete", danger: true }

test("the answer settles the question and closes the dialog", async () => {
  const shown: unknown[] = []
  const asker = createAsker((r) => shown.push(r))
  const yes = asker.ask(request)
  asker.answer(true)
  expect(await yes).toBe(true)
  const no = asker.ask(request)
  asker.answer(false)
  expect(await no).toBe(false)
  expect(shown).toEqual([request, null, request, null])
})

test("a second question answers the first one no", async () => {
  const asker = createAsker(() => {})
  const first = asker.ask(request)
  const second = asker.ask({ ...request, title: "Sign out?" })
  expect(await first).toBe(false)
  asker.answer(true)
  expect(await second).toBe(true)
})

test("an answer with nothing open only closes the dialog", () => {
  const shown: unknown[] = []
  createAsker((r) => shown.push(r)).answer(true)
  expect(shown).toEqual([null])
})

test("Cancel comes first; only destructive actions are red", () => {
  const danger = renderToStaticMarkup(<ConfirmActions cancelLabel="Cancel" confirmLabel="Delete" danger onAnswer={() => {}} />)
  expect(danger.indexOf("Cancel")).toBeLessThan(danger.indexOf("Delete"))
  expect(danger).toContain("bg-danger")
  expect(renderToStaticMarkup(<ConfirmActions cancelLabel="Cancel" confirmLabel="Import" onAnswer={() => {}} />)).not.toContain("bg-danger")
})

test("a yes that comes before the dialog has settled is dropped; a no always counts", () => {
  const answers: boolean[] = []
  let clock = 1000
  const answer = ignoreEarlyYes((ok) => answers.push(ok), 1000, () => clock)
  clock = 1000 + SETTLE_MS - 1
  answer(true)
  answer(false)
  clock = 1000 + SETTLE_MS
  answer(true)
  expect(answers).toEqual([false, true])
})

test("no confirmation is left on window.confirm()", () => {
  const offenders: string[] = []
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir)) {
      const path = join(dir, entry)
      if (statSync(path).isDirectory()) walk(path)
      else if (/\.tsx?$/.test(entry) && !/\.test\.tsx?$/.test(entry)) {
        // useConfirm() takes an object; the native one takes a string.
        if (/\b(?:window\.)?confirm\((?!\s*\{)/.test(readFileSync(path, "utf8"))) offenders.push(path)
      }
    }
  }
  walk(join(import.meta.dir, ".."))
  expect(offenders).toEqual([])
})
