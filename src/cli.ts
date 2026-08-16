#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { isDeepStrictEqual } from "node:util";
import { DefectiveFixtureServer, defectiveManifest } from "./fixture.js";
import { writeArtifacts } from "./report.js";
import { runDrill } from "./runner.js";
import type { ToolManifest } from "./schema.js";

async function main(args: string[]): Promise<number> {
  const [command = "help", ...rest] = args;
  if (command === "demo") {
    if (rest.length > 1 || rest[0]?.startsWith("-") === true) throw new Error("usage: tooldrill demo [OUT]");
    const out = rest[0] ?? "artifacts/demo";
    const report = await runDrill(defectiveManifest, new DefectiveFixtureServer(), { manifestUri: "fixtures/defective-manifest.json" });
    await writeArtifacts(out, report);
    const rules = [...new Set(report.results.flatMap((result) => result.findings.map((finding) => finding.ruleId)))].sort();
    const expectedRules = ["cancellation", "response-schema", "stable-error", "timeout"];
    const expectationSatisfied = JSON.stringify(rules) === JSON.stringify(expectedRules);
    console.log(JSON.stringify({ mode: "expected-detector-demo", outcome: expectationSatisfied ? "expected-findings-detected" : "detector-regression", findingsAreExpected: true, expectationSatisfied, out, totals: report.totals, rules }));
    return expectationSatisfied ? 0 : 1;
  }
  if (command === "fixture") {
    if (rest.length < 1 || rest.length > 2 || rest.some((value) => value.startsWith("-"))) throw new Error("usage: tooldrill fixture MANIFEST.json [OUT]");
    const [manifestPath, out = "artifacts/fixture"] = rest;
    if (manifestPath === undefined) throw new Error("usage: tooldrill fixture MANIFEST.json [OUT]");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as ToolManifest;
    if (!isDeepStrictEqual(manifest, defectiveManifest)) throw new Error("fixture command supports only the bundled defective manifest; use runDrill with an explicit ToolServer adapter for other manifests");
    const report = await runDrill(manifest, new DefectiveFixtureServer(), { manifestUri: manifestPath });
    await writeArtifacts(out, report);
    const passed = report.totals.failed === 0;
    console.log(JSON.stringify({ mode: "fixture-conformance", outcome: passed ? "passed" : "failed", findingsAreExpected: false, out, totals: report.totals }));
    return passed ? 0 : 1;
  }
  if (["help", "--help", "-h"].includes(command) && rest.length > 0) throw new Error("help does not accept operands");
  console.log("tooldrill demo [OUT]\ntooldrill fixture MANIFEST.json [OUT]");
  return command === "help" || command === "--help" || command === "-h" ? 0 : 2;
}

main(process.argv.slice(2)).then((code) => { process.exitCode = code; }).catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
