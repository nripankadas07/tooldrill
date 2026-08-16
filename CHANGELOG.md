# Changelog

## [0.1.1] - 2026-08-16

### Changed

- Clone and deeply freeze every generated case before adapter invocation, keeping authenticated inputs and repeated attempts isolated from a mutating server implementation.
- Count JSON Schema `minLength` and `maxLength` in Unicode code points rather than UTF-16 code units.
- Add practical width, enum, schema-node, generated-case, and aggregate-witness budgets that reject expensive manifests before case materialization.
- Measure nested `const` and `enum` JSON values iteratively before cloning, rejecting cycles, sparse arrays, non-plain objects, non-finite numbers, excessive depth/nodes/strings, aggregate literal overload, and generated-case expansion with saturating budget arithmetic.
- Reject patterns with multiple variable repetitions and bound regex evaluation inputs to 100,000 Unicode code points, preventing ambiguous-repetition backtracking in direct validation and response checks.
- Reject trailing CLI operands and option-like positional values.
- Reject sparse or extended `enum` and `required` arrays as non-JSON schema structure.
- Publish reports through component-verified staging, directory/target identity rechecks, per-file atomic renames, and set-level backup/rollback. Output-path and target-file symlinks are rejected before any artifact is replaced.
- Serialize cooperative artifact writers with a bounded fail-closed filesystem lock and reconcile rename-then-error outcomes by inode identity, preventing mixed concurrent bundles and restoring the full prior set after ambiguous failures.
- Emit ToolDrill `0.1.1` in SARIF metadata.

Manifests above the new resource budgets—including oversized or deeply nested `const`/`enum` literals—patterns outside the conservative non-ambiguous subset, oversized pattern inputs, and adapters that mutate invocation arguments can be rejected where `0.1.0` attempted to continue.

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
