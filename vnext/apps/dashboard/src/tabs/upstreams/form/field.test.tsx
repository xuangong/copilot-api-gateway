import { expect, test } from "bun:test"
import { renderToStaticMarkup } from "react-dom/server"
import { Select } from "../../../ui/select"
import { Field } from "./Field"

test("Field's label points at the select it names", () => {
  const html = renderToStaticMarkup(
    <Field label="Auth style">
      {({ id, labelId }) => <Select id={id} labelledBy={labelId} value="" onChange={() => {}} options={[{ value: "", label: "Bearer" }]} />}
    </Field>,
  )
  const forId = html.match(/<label[^>]*\sfor="([^"]+)"/)?.[1]
  expect(forId).toBeTruthy()
  expect(html.match(/<button[^>]*\sid="([^"]+)"/)?.[1]).toBe(forId)
})
