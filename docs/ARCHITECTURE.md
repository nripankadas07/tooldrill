# Architecture

```text
tool manifest
  -> supported-schema check
  -> deterministic boundary/invalid generator
  -> explicit ToolServer fixture adapter
  -> input and output validation
  -> repeated-error / timeout / cancellation checks
  -> primitive counterexample shrinking
  -> versioned case results
  -> JSON + Markdown + JUnit + SARIF + single-file HTML
```

`schema.ts` implements a strict documented JSON Schema subset. It rejects unknown keywords and incoherent/resource-unsafe schemas, validates own properties, and requires a deterministic witness for supported patterns. `cases.ts` recursively walks object properties and array items in sorted order, validates every case label against the schema, and produces stable IDs and values. `runner.ts` supplies explicit invocation contexts rather than relying on wall-clock races. This makes timeout and cancellation transcript tests deterministic.

The fixture server is an in-process simulation implementing the `ToolServer` interface. The CLI refuses to pair that server with a different manifest. A real adapter can map the same interface to a spawned stdio server or another explicit transport, with transport behavior and limitations documented separately. Invocation variants, elapsed time, transcripts, and error payloads are runtime-validated. Malformed returns and adapter exceptions become generic per-case `server-error` findings so a single adapter fault cannot abort the evidence run or leak its message.

Shrinking operates only on the first invalid primitive associated with a validation issue. Candidate values are attempted in a stable order and retained when the repeated call still demonstrates an unstable error.
