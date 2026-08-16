# ToolDrill

ToolDrill is a deterministic, zero-runtime-dependency conformance and property tester for MCP-style tool manifests. It generates JSON Schema boundary and invalid inputs, validates response schemas, probes timeout and cancellation behavior, repeats invalid calls to check stable errors, shrinks primitive failures, and writes CI-friendly evidence.

The bundled `temperature.convert` server is a deliberately defective **offline simulator**. It proves that ToolDrill detectors fire; it is not a benchmark of a production MCP server and it does not open a transport connection.

## Quick start

Requires Node.js 22 or newer.

```bash
npm ci
npm test
npm run demo
```

`demo` is a detector self-test: its fixture is intentionally broken, the findings are expected, and the command succeeds only when the four seeded detector families are observed. By contrast, `fixture` is a conformance command and exits nonzero whenever its report contains failed cases. The CLI fixture command accepts only the bundled defective manifest because that is the only server adapter it can honestly execute; custom manifests must use the SDK's `runDrill(manifest, explicitServerAdapter)` contract.

Open `artifacts/demo/index.html`. The demo writes:

- `report.json` and `report.md`;
- `junit.xml` for test systems;
- `results.sarif` for code-scanning systems;
- a self-contained `index.html` report.

Run the checked-in manifest through the fixture executor:

```bash
node dist/src/cli.js fixture fixtures/defective-manifest.json artifacts/fixture
```

The command above intentionally exits with status `1` because the checked-in fixture has conformance findings; it still writes the complete evidence bundle before exiting.

## What v1 tests

- nested required properties and `additionalProperties`, using own-property semantics;
- primitive types, enums, constants, string lengths/patterns, numeric limits, and array sizes;
- deterministic, schema-validated minimum/maximum boundary values, including nested object/array nodes;
- wrong types, missing values, invalid enums, range overflow, bad patterns, and unexpected properties;
- output-schema conformance;
- repeated invalid-input error stability;
- timeout and pre-dispatch cancellation transcript behavior;
- primitive counterexample shrinking.

Manifests are runtime-validated before generation. Unsupported keywords such as `$ref` and `oneOf`, unknown types, invalid or unsynthesizable patterns, empty enums, missing required-property definitions, contradictory bounds, non-finite/oversized limits, and cyclic schema objects fail closed instead of being silently ignored. Every generated case is checked against the input schema before an adapter is invoked.

## Stable artifacts

- `tooldrill.manifest/v1`
- `tooldrill.result/v1`
- `tooldrill.report/v1`
- SARIF `2.1.0`

## Honest fixture faults

The fixture intentionally:

1. alternates invalid-input error codes/messages;
2. returns an invalid response at the maximum temperature boundary;
3. ignores a declared timeout;
4. ignores a pre-cancelled call.

Tests assert that all four rule families are reported.

See [architecture](docs/ARCHITECTURE.md), [limitations](docs/LIMITATIONS.md), and [research notes](docs/RESEARCH.md).

## License

MIT

See the [roadmap](ROADMAP.md), [research notes](docs/RESEARCH.md), and [AI-assistance disclosure](AI_ASSISTED.md).
