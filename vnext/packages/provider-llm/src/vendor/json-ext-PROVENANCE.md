# JSON structural traversal provenance

The traversal in `../json-ext-traversal.ts` is a narrow adaptation of `@discoveryjs/json-ext` v1.1.0, Git commit `bfc88518775c0a587bc1d119ea7daa6f97060858` at https://github.com/discoveryjs/json-ext/tree/v1.1.0. The inspected upstream source is `src/stringify-chunked.js`; its option helpers in `src/utils.js` were read for compatibility evaluation but are not copied. The MIT notice is reproduced verbatim in `json-ext-LICENSE`.

The upstream explicit stack/state, object and array entry progression, `Object.keys` enumeration, punctuation, and bracket ordering inform the adapted traversal. Replacer, indentation, JSONL, `replaceValue`, whole escaped-key caching, and string buffering were removed. Snapshot normalization lives separately in `../json-snapshot.ts`. Primitive and key emission uses native `JSON.stringify` on bounded string slices and a 65,536-byte accumulator; every yielded byte array is independently owned.

The Git source was inspected. The npm tarball and its integrity were not independently verified, and the npm package was not installed for this adaptation.
