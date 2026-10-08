import { expect, test } from "bun:test"
import { referenceMigrationInputs, referenceSinkCounts, verifyReferenceBuildAgreement } from "./reference-qualify.ts"

const root = "/frozen/reference"
const migrationRoot = root + "/packages/gateway/migrations"
const inputs = Array.from({ length: 86 }, (_, index) => ({ path: `${migrationRoot}/${String(index + 1).padStart(4, "0")}.sql`, sha256: "a".repeat(64) }))

test("reference qualification requires exactly the 86 frozen native migrations", () => {
  expect(referenceMigrationInputs({ migrationRoot, inputs })).toEqual(inputs)
  expect(() => referenceMigrationInputs({ migrationRoot, inputs: inputs.slice(1) })).toThrow("86")
  expect(() => referenceMigrationInputs({ migrationRoot, inputs: [...inputs, inputs[0]!] })).toThrow("duplicate")
})

test("control and probe must consume the same frozen source and dependencies", () => {
  verifyReferenceBuildAgreement(inputs, [...inputs].reverse())
  expect(() => verifyReferenceBuildAgreement(inputs, inputs.slice(1))).toThrow("population")
  expect(() => verifyReferenceBuildAgreement(inputs, inputs.map((input, index) => index === 0 ? { ...input, sha256: "b".repeat(64) } : input))).toThrow("changed")
})

test("sink counts retain native physical object population and compressed sizes", () => {
  expect(referenceSinkCounts({ objects: [{ size: 9 }, { size: 20 }], compressedBytes: 29 })).toEqual({ objects: 2, compressedBytes: 29 })
  expect(() => referenceSinkCounts({ objects: [{ size: 9 }], compressedBytes: 10 })).toThrow("physical")
  expect(() => referenceSinkCounts({ objects: [{ size: -1 }], compressedBytes: -1 })).toThrow("physical")
})
