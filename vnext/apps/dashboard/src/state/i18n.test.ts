import { expect, test } from "bun:test"
import { dateLocale, t } from "./i18n"
import { installDictionary } from "./i18n-fixture"

test("without a page script t() hands back the key and dates are en-US", () => {
  expect(t("dash.delete")).toBe("dash.delete")
  expect(dateLocale()).toBe("en-US")
})

test("dates follow the interface language", () => {
  const restore = installDictionary("zh")
  try {
    expect(t("dash.delete")).toBe("删除")
    expect(dateLocale()).toBe("zh-CN")
  } finally {
    restore()
  }
  expect(dateLocale()).toBe("en-US")
  expect(t("dash.delete")).toBe("dash.delete")
})
