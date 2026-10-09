# Shared session key delivery

Spec: ../specs/2026-10-10-shared-session-key.md

- [x] Add private SQLite/D1 fields and owner-only settings/reveal routes; verify
      disabled defaults, atomic enable validation, secret redaction and isolation.
- [x] Add shared v3/v4 codecs and credential-scoped portable matching; verify
      independent instances, mismatched keys and retained execution fencing.
- [x] Add the existing-style Key settings panel, generate/paste/reveal/copy,
      enable/save/cancel behavior and bilingual copy; verify UI/API contracts.
- [x] Complete three-instance HTTP/SQLite acceptance and full local CI; document
      deployment order, rollback limits and old-history limitations; commit only
      this task's files on vNext, preserving the existing collaboration overlay.

No deployment is part of this implementation task.

Verification: full local CI passed (6,710 pass, 2 skip, 0 fail); headless Chrome
settings smoke passed. See the spec for evidence boundaries and release steps.
