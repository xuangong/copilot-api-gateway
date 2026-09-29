# C01 pinned native-client carrier acceptance

Pinned first-party Codex source: 8ff74cc9b11ac54c4c4446ef60a87b49ae657a1f, retained isolated archive under codex-client-runtime/source. Production client code was unchanged. Root appended two uniquely named tests to core/tests/suite/client.rs; exact added fixture is task-C01-native-client-fixture.rs.txt. task-C01-native-carrier-generate.mjs imports accepted a79fbb48 foundation and generates actual synthetic authenticated carriers in task-C01-native-carriers.json.

Command: cargo test --locked -p codex-core --test all suite::client::vnext_c01_affinity_ -- --nocapture. Environment is fully replaced, with isolated HOME/CODEX_HOME/XDG/temp/Cargo cache and target, existing RUSTUP_HOME, CARGO_BUILD_JOBS=4 and RUST_MIN_STACK=16777216, following the committed websocket-client-fixture-results guide. No live credentials, daemon, original Codex checkout or gateway configuration was touched.

Actual result: exit 0; 2 passed, 0 failed, 0 ignored, 1727 filtered out; 0.68s test runtime after 25.47s incremental build. Existing unused body_json import warning remains. Tests run actual Codex turn processing against local scripted SSE servers: reasoning carrier received on first turn is replayed byte-exact on second; RemoteCompactionV2 carrier received during Op::Compact is replayed byte-exact on the following turn. Request counts are exactly 2 and 3 respectively. This establishes outer marker compatibility with this pinned client's receive/history/next-turn paths. It does not establish live provider compatibility, gateway integration, other clients, or Messages thinking signature consumers.

Log: codex-client-runtime/logs/c01-affinity-native.log; SHA-256 53e03682d8bd6516d2aad0379d55adbf328e918570040816b8b6203b2deb5ccc.
