# Changelog

## [0.1.0] - 2026-08-16

### Added

- Deterministic JSON Schema subset validator and case generator.
- Boundary, invalid-input, stable-error, timeout, and cancellation probes.
- Output validation and primitive counterexample shrinking.
- Deliberately defective offline fixture server.
- JSON, Markdown, JUnit XML, SARIF 2.1.0, and single-file HTML reports.
- Array-cardinality and const-violation generators plus non-finite number rejection.
- Explicit CLI semantics: expected detector-demo findings exit zero; conformance findings exit nonzero.
- Strict fail-closed manifest/schema validation for unsupported keywords/types, regex witnesses, bounds, enums, required properties, and generation limits.
- Own-property validation and recursively classified nested object/array case generation.
- Strict invocation-result validation plus per-case generic malformed-return/adapter-exception findings, manifest-aware SARIF locations, Markdown/HTML escaping, and XML 1.0 control sanitization.
- CLI refusal to pair arbitrary manifests with the bundled defective server and clean-source npm package/import/CLI smoke coverage.
