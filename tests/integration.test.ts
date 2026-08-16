import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, rename as fsRename, rmdir, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { spawnSync } from "node:child_process";
import { DefectiveFixtureServer, defectiveManifest } from "../src/fixture.js";
import { htmlReport, junitReport, markdownReport, sarifReport, writeArtifacts } from "../src/report.js";
import { writeArtifactSet } from "../src/safe-output.js";
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

test("mutating adapters cannot rewrite generated case evidence", async () => {
  const report = await runDrill(defectiveManifest, {
    invoke: async (args, context) => {
      if (context.cancelled) return { status: "cancelled", elapsedMs: 0, transcript: [] };
      if (context.timeoutMs !== undefined) return { status: "timeout", elapsedMs: context.timeoutMs, transcript: [] };
      delete args.temperature;
      return { status: "ok", value: {}, elapsedMs: 0, transcript: [] };
    },
  });
  const baseline = report.results.find((result) => result.caseId === "valid.baseline");
  assert.ok(baseline);
  assert.equal(baseline.status, "fail");
  assert.ok(baseline.findings.some((finding) => finding.ruleId === "server-error"));
  assert.ok(Object.hasOwn(baseline.arguments, "temperature"));
  assert.equal(baseline.inputIssues.length, 0);
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

test("CLI rejects trailing operands and option-like output paths", () => {
  for (const args of [["demo", "out", "extra"], ["demo", "--typo"], ["fixture", "manifest.json", "out", "extra"]]) {
    const result = spawnSync(process.execPath, ["dist/src/cli.js", ...args], { encoding: "utf8" });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /usage:/u);
  }
});

test("artifact publication rejects symlink and non-directory targets before writing", async () => {
  const root = await mkdtemp(join(tmpdir(), "tooldrill-safe-output-"));
  const victim = join(root, "victim.txt");
  await writeFile(victim, "unchanged\n");
  const report = await runDrill(defectiveManifest, new DefectiveFixtureServer());

  const fileTarget = join(root, "file-target");
  await mkdir(fileTarget);
  await symlink(victim, join(fileTarget, "report.json"));
  await assert.rejects(writeArtifacts(fileTarget, report), /regular file/u);
  assert.equal(await readFile(victim, "utf8"), "unchanged\n");
  assert.deepEqual(await readdir(fileTarget), ["report.json"]);

  const directoryVictim = join(root, "directory-victim");
  await mkdir(directoryVictim);
  const linkedOutput = join(root, "linked-output");
  await symlink(directoryVictim, linkedOutput);
  await assert.rejects(writeArtifacts(linkedOutput, report), /symbolic-link component/u);
  await assert.rejects(writeArtifacts(join(linkedOutput, "nested"), report), /symbolic-link component/u);
  assert.deepEqual(await readdir(directoryVictim), []);

  const parentFile = join(root, "not-a-directory");
  await writeFile(parentFile, "x");
  await assert.rejects(writeArtifacts(join(parentFile, "child"), report));

  const transactional = join(root, "transactional");
  await mkdir(transactional);
  await writeFile(join(transactional, "one.txt"), "original\n");
  let publishes = 0;
  await assert.rejects(writeArtifactSet(transactional, { "one.txt": "replacement\n", "two.txt": "new\n" }, {
    publishRename: async (source, destination) => {
      publishes += 1;
      if (publishes === 2) throw new Error("injected second publish failure");
      await fsRename(source, destination);
    },
  }), /injected second publish failure/u);
  assert.equal(publishes, 2);
  assert.equal(await readFile(join(transactional, "one.txt"), "utf8"), "original\n");
  assert.deepEqual(await readdir(transactional), ["one.txt"]);

  const ambiguous = join(root, "ambiguous-rename");
  await mkdir(ambiguous);
  await writeFile(join(ambiguous, "one.txt"), "original-one\n");
  await writeFile(join(ambiguous, "two.txt"), "original-two\n");
  let completedRenames = 0;
  await assert.rejects(writeArtifactSet(ambiguous, { "one.txt": "replacement-one\n", "two.txt": "replacement-two\n" }, {
    publishRename: async (source, destination) => {
      await fsRename(source, destination);
      completedRenames += 1;
      if (completedRenames === 2) throw new Error("injected post-rename failure");
    },
  }), /injected post-rename failure/u);
  assert.equal(await readFile(join(ambiguous, "one.txt"), "utf8"), "original-one\n");
  assert.equal(await readFile(join(ambiguous, "two.txt"), "utf8"), "original-two\n");
  assert.deepEqual(await readdir(ambiguous), ["one.txt", "two.txt"]);

  const concurrent = join(root, "concurrent-writers");
  await mkdir(concurrent);
  const pause = async (): Promise<void> => new Promise((resolvePause) => { setTimeout(resolvePause, 20); });
  const writer = async (label: "A" | "B"): Promise<void> => {
    let writerRenames = 0;
    await writeArtifactSet(concurrent, { "one.txt": `${label}\n`, "two.txt": `${label}\n` }, {
      publishRename: async (source, destination) => {
        writerRenames += 1;
        if (label === "A" && writerRenames === 1) await pause();
        await fsRename(source, destination);
        if (label === "B" && writerRenames === 1) await pause();
      },
    });
  };
  await Promise.all([writer("A"), writer("B")]);
  const concurrentContents = await Promise.all(["one.txt", "two.txt"].map(async (name) => readFile(join(concurrent, name), "utf8")));
  assert.equal(concurrentContents[0], concurrentContents[1]);
  assert.ok(concurrentContents[0] === "A\n" || concurrentContents[0] === "B\n");
  assert.deepEqual(await readdir(concurrent), ["one.txt", "two.txt"]);

  const stale = join(root, "stale-lock");
  await mkdir(stale);
  const staleLock = join(stale, ".artifact-write.lock");
  await mkdir(staleLock);
  await assert.rejects(writeArtifactSet(stale, { "one.txt": "unpublished\n" }, { lockTimeoutMs: 0 }), /lock is held or stale/u);
  assert.deepEqual(await readdir(stale), [".artifact-write.lock"]);
  await rmdir(staleLock);
});
