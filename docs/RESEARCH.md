# Research notes

- [Model Context Protocol specification](https://github.com/modelcontextprotocol/modelcontextprotocol) supplies the surrounding tool-manifest context.
- [JSON Schema](https://github.com/json-schema-org/json-schema-spec) motivates schema-driven generation and validation. ToolDrill documents and tests a subset rather than claiming full compliance.
- [QuickCheck](https://dl.acm.org/doi/10.1145/351240.351266) and property-based testing motivate generated cases and counterexample shrinking.
- [JUnit XML](https://github.com/testmoapp/junitxml) is emitted for broad CI ingestion; no single official schema governs every consumer.
- [SARIF 2.1.0](https://docs.oasis-open.org/sarif/sarif/v2.1.0/sarif-v2.1.0.html) provides machine-readable findings.

The core hypothesis is falsifiable: schema-derived boundary cases plus transport-contract probes can expose tool-server defects before agents encounter them. The checked-in fixture seeds known faults so the test suite verifies detector sensitivity, not just report generation.
