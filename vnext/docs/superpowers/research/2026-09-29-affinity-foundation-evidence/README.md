# Authenticated opaque affinity foundation

C01 foundation adds private per-key initialization, bounded authenticated carriers, explicit trusted compatibility declarations and pure request analysis. Production routing and egress activation remain separate follow-up packages; this foundation does not itself enable client affinity.

The frozen 17-path product package passed independent spec and quality review. Root ran `bun run ci:local`: 4743 pass, 1 existing skip, 0 fail, 84192 assertions; type checks, purity, lint (35 inherited warnings), dashboard build and Workers dry-run passed. The existing multiple-tsconfig resolver notice remains.

Actual Bun and local workerd/D1 acceptance passed against frozen imports: every UTF-16 code unit, authenticated scope/content/domain rejection, malformed and oversized carriers, foreign preservation, whole-block degradation, required-state fencing, independent candidate materialization, and 16 concurrent initializers returning the same D1 winner. Actual session API reads do not expose private material; ordinary save and key rotation preserve it. No outbound requests occurred. Fixtures use synthetic identities and temporary databases.

See `runtime-result.json`, the implementation report, independent review and executable fixtures in this directory. No live provider or native-client affinity activation is claimed. The trusted provider compatibility hook is currently unimplemented by production providers, so arbitrary discovery metadata cannot widen compatibility. Production selectors, actual execution identity, egress/storage continuation, nested agent-message fields and Chat/Gemini adapters remain C01 follow-up work.
