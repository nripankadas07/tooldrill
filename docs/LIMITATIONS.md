# Limitations

- The bundled executor is an offline, in-process defective simulation; no production MCP server is contacted.
- The validator implements a strict JSON Schema subset, not every draft keyword or reference mechanism. Unsupported keywords are rejected rather than ignored.
- `$ref`, `oneOf`, `anyOf`, `allOf`, grouping/alternation in generated regex witnesses, conditional schemas, formats, recursive references, and unevaluated properties are not supported in v1.
- Pattern generation supports flat literals, dot/basic escapes, character classes with a deterministic ASCII witness, anchors, and `?`, `*`, `+`, or bounded repetitions. A valid regex outside that generation subset is rejected explicitly.
- Generated string/array cardinalities are capped at 10,000, aggregate deterministic witnesses at 50,000 nodes, schema graphs at 2,000 nodes/32 levels, and numeric generation bounds at JavaScript's safe-integer magnitude.
- Generated cases are deterministic and targeted, not exhaustive fuzzing.
- Timeout tests use explicit invocation metadata in the fixture. A real transport adapter must enforce and measure actual deadlines.
- Cancellation tests model a pre-cancelled call; concurrent mid-flight cancellation requires a transport adapter.
- Primitive shrinking does not yet minimize nested objects or arrays.
- SARIF locations preserve the supplied manifest URI as a review anchor, but do not claim exact source lines in a remote server.
- Passing ToolDrill does not prove security, availability, semantic correctness, or protocol completeness.
