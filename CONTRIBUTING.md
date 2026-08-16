# Contributing

1. Open an issue describing the schema keyword, case generator, adapter, or report contract.
2. Keep runtime dependencies at zero.
3. Add a seeded fixture fault and a detector test when adding a rule.
4. Keep generation and shrinking deterministic.
5. Run `npm test` and `npm run demo` on Node 22 or newer.
6. Use a new artifact version for breaking changes.
