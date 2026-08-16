import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { spawnSync } from "node:child_process";
import { DefectiveFixtureServer, defectiveManifest } from "../src/fixture.js";
import { htmlReport, junitReport, markdownReport, sarifReport, writeArtifacts } from "../src/report.js";
import { runDrill } from "../src/runner.js";

test("defective fixture proves every seeded conformance detector", async () => {
  const report = await runDrill(defectiveManifest, new DefectiveFixtureServer());
  const rules = new Set(report.results.flatMap((result) => result.findings.map((finding) => finding.ruleId)));
  assert.ok(rules.has("response-schema"));
  assert.ok(rules.has("stable-error"));
  assert.ok(rules.has("timeout"));
  assert.ok(rules.has("cancellation"));
  assert.ok(report.totals.failed > 0);
  assert.ok(report.results.some((result) => result.shrunkArguments !== undefined));
  const golden = JSON.parse(await readFile("examples/golden/expected.json", "utf8")) as { totals: typeof report.totals; seededFindingRules: string[] };
  assert.deepEqual(report.totals, golden.totals);
  assert.deepEqual([...rules].sort(), golden.seededFindingRules);
});

test("JSON, Markdown, JUnit, SARIF, and HTML artifacts are deterministic", async () => {
  const report = await runDrill(defectiveManifest, new DefectiveFixtureServer());
  const first = await mkdtemp(join(tmpdir(), "tooldrill-a-"));
  const second = await mkdtemp(join(tmpdir(), "tooldrill-b-"));
  await writeArtifacts(first, report);
  await writeArtifacts(second, report);
  for (const name of ["report.json", "report.md", "junit.xml", "results.sarif", "index.html"]) {
    assert.equal(await readFile(join(first, name), "utf8"), await readFile(join(second, name), "utf8"));
  }
  assert.equal(JSON.parse(await readFile(join(first, "results.sarif"), "utf8")).version, "2.1.0");
  assert.match(await readFile(join(first, "junit.xml"), "utf8"), /<testsuite/u);
  assert.match(await readFile(join(first, "index.html"), "utf8"), /<!doctype html>/u);
});

test("adapter exceptions become deterministic per-case findings without leaking messages", async () => {
  const secret = "sk_transport_secret_987654";
  const report = await runDrill(defectiveManifest, { invoke: async () => { throw new Error(secret); } });
  assert.equal(report.results.length, report.totals.cases);
  assert.equal(report.totals.failed, report.totals.cases);
  assert.ok(report.results.every((result) => result.findings.some((finding) => finding.ruleId === "server-error")));
  assert.ok(!JSON.stringify(report).includes(secret));

  const malformed = await runDrill(defectiveManifest, { invoke: async () => ({ status: "timeout", elapsedMs: Number.NaN, transcript: [] }) as never });
  assert.equal(malformed.totals.failed, malformed.totals.cases);
  assert.ok(malformed.results.every((result) => result.findings.some((finding) => finding.ruleId === "server-error")));
});

test("reports escape Markdown and HTML, sanitize XML 1.0 controls, and preserve manifest URI", async () => {
  const report = await runDrill(defectiveManifest, new DefectiveFixtureServer(), { manifestUri: "custom/path/manifest.json" });
  const hostile = structuredClone(report);
  hostile.manifest.name = "`\n\n## Forged section\n- forged\n<img src=x onerror=alert(1)>\u0001";
  const firstResult = hostile.results[0];
  assert.ok(firstResult);
  firstResult.caseId = "case`\n<img src=x onerror=alert(2)>";
  firstResult.transcript.push("bad\u0003line");
  const firstFinding = hostile.results.find((result) => result.findings.length > 0)?.findings[0];
  assert.ok(firstFinding);
  firstFinding.message += "\u0002bad";
  const markdownOutput = markdownReport(hostile);
  assert.ok(!markdownOutput.includes("<img src=x"));
  assert.ok(!markdownOutput.includes("\n## Forged section"));
  assert.ok(!markdownOutput.includes("\n- forged"));
  assert.ok(!htmlReport(hostile).includes("<img src=x"));
  assert.ok(![...junitReport(hostile)].some((character) => {
    const code = character.charCodeAt(0);
    return code < 0x20 && code !== 0x9 && code !== 0xa && code !== 0xd;
  }));
  const uri = sarifReport(hostile).runs[0]?.results[0]?.locations[0]?.physicalLocation.artifactLocation.uri;
  assert.equal(uri, "custom/path/manifest.json");
});

test("CLI distinguishes the expected detector demo from a failing conformance command", async () => {
  const demoOut = await mkdtemp(join(tmpdir(), "tooldrill-cli-demo-"));
  const demo = spawnSync(process.execPath, ["dist/src/cli.js", "demo", demoOut], { encoding: "utf8" });
  assert.equal(demo.status, 0, demo.stderr);
  const demoSummary = JSON.parse(demo.stdout) as { mode: string; findingsAreExpected: boolean; expectationSatisfied: boolean; totals: { failed: number } };
  assert.equal(demoSummary.mode, "expected-detector-demo");
  assert.equal(demoSummary.findingsAreExpected, true);
  assert.equal(demoSummary.expectationSatisfied, true);
  assert.ok(demoSummary.totals.failed > 0);

  const fixtureOut = await mkdtemp(join(tmpdir(), "tooldrill-cli-fixture-"));
  const fixture = spawnSync(process.execPath, ["dist/src/cli.js", "fixture", "fixtures/defective-manifest.json", fixtureOut], { encoding: "utf8" });
  assert.equal(fixture.status, 1, fixture.stderr);
  const fixtureSummary = JSON.parse(fixture.stdout) as { mode: string; outcome: string; findingsAreExpected: boolean; totals: { failed: number } };
  assert.equal(fixtureSummary.mode, "fixture-conformance");
  assert.equal(fixtureSummary.outcome, "failed");
  assert.equal(fixtureSummary.findingsAreExpected, false);
  assert.ok(fixtureSummary.totals.failed > 0);

  const unsupportedPath = join(fixtureOut, "other-manifest.json");
  const other = structuredClone(defectiveManifest);
  other.name = "another-server";
  await writeFile(unsupportedPath, `${JSON.stringify(other)}\n`);
  const unsupported = spawnSync(process.execPath, ["dist/src/cli.js", "fixture", unsupportedPath, join(fixtureOut, "other")], { encoding: "utf8" });
  assert.equal(unsupported.status, 1);
  assert.match(unsupported.stderr, /supports only the bundled defective manifest/u);
});
