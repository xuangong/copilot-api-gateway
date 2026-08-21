import { describe, expect, it } from "bun:test"
import type { Part } from "./parts"
import { adoptImageIds, collectImageIds, hydrateMessage, migrateMessage, stripImageBytes } from "./persistence"

const PNG = "data:image/png;base64,AAAA"
const JPG = "data:image/jpeg;base64,BBBB"

const msg = (parts?: Part[], text = "") => ({ role: "user" as const, text, parts })

describe("stripImageBytes", () => {
  it("drops the bytes but keeps the id and the position", () => {
    const m = msg([
      { type: "text", text: "a" },
      { type: "image", dataUrl: PNG, id: "i1" },
      { type: "text", text: "b" },
    ])
    expect(stripImageBytes(m).parts).toEqual([
      { type: "text", text: "a" },
      { type: "image", dataUrl: "", id: "i1" },
      { type: "text", text: "b" },
    ])
  })

  it("returns the same object when there is nothing to strip", () => {
    const m = msg([{ type: "text", text: "a" }])
    expect(stripImageBytes(m)).toBe(m)
  })

  it("leaves a message without parts alone", () => {
    const m = msg(undefined, "hello")
    expect(stripImageBytes(m)).toBe(m)
  })

  it("preserves fields it does not know about", () => {
    const m = { ...msg([{ type: "image", dataUrl: PNG, id: "i1" }]), durationMs: 12 }
    expect(stripImageBytes(m).durationMs).toBe(12)
  })
})

describe("hydrateMessage", () => {
  it("puts the bytes back by id", () => {
    const m = msg([
      { type: "text", text: "a" },
      { type: "image", dataUrl: "", id: "i1" },
    ])
    expect(hydrateMessage(m, new Map([["i1", PNG]])).parts).toEqual([
      { type: "text", text: "a" },
      { type: "image", dataUrl: PNG, id: "i1" },
    ])
  })

  it("leaves an image whose bytes are gone as an empty dataUrl", () => {
    const m = msg([{ type: "image", dataUrl: "", id: "gone" }])
    expect(hydrateMessage(m, new Map()).parts).toEqual([
      { type: "image", dataUrl: "", id: "gone" },
    ])
  })

  it("returns the same object when nothing needs hydrating", () => {
    const m = msg([{ type: "image", dataUrl: PNG, id: "i1" }])
    expect(hydrateMessage(m, new Map([["i1", PNG]]))).toBe(m)
  })
})

describe("adoptImageIds", () => {
  it("attaches a store id to an image a previous release kept inline", () => {
    const m = msg([{ type: "image", dataUrl: PNG }])
    expect(adoptImageIds(m, new Map([[PNG, "i9"]])).parts).toEqual([
      { type: "image", dataUrl: PNG, id: "i9" },
    ])
  })

  it("leaves images that already have an id alone", () => {
    const m = msg([{ type: "image", dataUrl: PNG, id: "old" }])
    expect(adoptImageIds(m, new Map([[PNG, "new"]]))).toBe(m)
  })

  it("returns the same object when there is nothing to adopt", () => {
    const m = msg([{ type: "text", text: "a" }])
    expect(adoptImageIds(m, new Map([[PNG, "i9"]]))).toBe(m)
  })
})

describe("collectImageIds", () => {
  it("gathers ids across messages without duplicates", () => {
    const ids = collectImageIds([
      msg([{ type: "image", dataUrl: "", id: "i1" }]),
      msg([{ type: "text", text: "x" }]),
      msg([
        { type: "image", dataUrl: "", id: "i2" },
        { type: "image", dataUrl: "", id: "i1" },
      ]),
    ])
    expect(ids.sort()).toEqual(["i1", "i2"])
  })

  it("ignores images that never got an id", () => {
    expect(collectImageIds([msg([{ type: "image", dataUrl: PNG }])])).toEqual([])
  })
})

describe("migrateMessage", () => {
  it("turns a legacy single imageUrl into a trailing image part", () => {
    const m = { role: "user" as const, text: "look", imageUrl: JPG }
    expect(migrateMessage(m)).toEqual({
      role: "user",
      text: "look",
      parts: [
        { type: "text", text: "look" },
        { type: "image", dataUrl: JPG },
      ],
    })
  })

  it("drops the legacy field once migrated", () => {
    const out = migrateMessage({ role: "user" as const, text: "", imageUrl: JPG })
    expect("imageUrl" in out).toBe(false)
  })

  it("leaves an already-migrated message untouched", () => {
    const m = msg([{ type: "text", text: "a" }], "a")
    expect(migrateMessage(m)).toBe(m)
  })

  it("leaves a plain text message untouched", () => {
    const m = msg(undefined, "a")
    expect(migrateMessage(m)).toBe(m)
  })
})
