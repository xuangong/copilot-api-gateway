import { expect, test } from "bun:test"
import { formatLokiPairing } from "./loki-pairing"

const pairing = { version: 1, gatewayOrigin: "https://gateway.example", upstreamId: "up_loki_fixture",
  profileId: "loki-df-v1", generation: "fixture-generation", syncSecret: `lks_${"a".repeat(64)}` }

test("pairing document is restricted to the selected HTTPS gateway and fixed profile", () => {
  expect(JSON.parse(formatLokiPairing(pairing, "https://gateway.example"))).toEqual(pairing)
  for (const patch of [{ gatewayOrigin: "https://other.example" }, { gatewayOrigin: "http://gateway.example" },
    { gatewayOrigin: "https://gateway.example/steal" }, { profileId: "arbitrary-profile" }, { syncSecret: "bad" }, { version: 2 }]) {
    expect(() => formatLokiPairing({ ...pairing, ...patch }, "https://gateway.example")).toThrow()
  }
})

test("pairing output cannot accidentally include upstream credentials or internal fields", () => {
  const output = formatLokiPairing({ ...pairing, credential: { accessToken: "private-token" }, syncSecretHash: "private-hash" }, "https://gateway.example")
  expect(output).not.toContain("private-token")
  expect(output).not.toContain("private-hash")
})
