# Release process

1. Run `npm ci && npm run package:smoke && npm run check` on Node 22. The smoke test packs from source, installs the tarball, imports the library, and executes the installed CLI.
2. Compare totals and finding rules to `examples/golden/expected.json`.
3. Parse `report.json` and `results.sarif`; validate JUnit XML 1.0 and inspect the HTML root.
4. Confirm at least one shrunk counterexample is present.
5. Review manifest, result, report, JUnit, and SARIF contracts.
6. Update package version and `CHANGELOG.md` together.
7. Package source plus demo evidence; label the bundled executor as a deliberately defective offline simulation.
8. Confirm `demo` reports `findingsAreExpected: true`, while the defective `fixture` command exits nonzero after writing artifacts.
