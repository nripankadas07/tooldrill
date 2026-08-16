import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { DrillReport, Finding } from "./runner.js";

function xml(value: unknown): string {
  const valid = [...String(value)].filter((character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return codePoint === 0x9 || codePoint === 0xa || codePoint === 0xd || (codePoint >= 0x20 && codePoint <= 0xd7ff) || (codePoint >= 0xe000 && codePoint <= 0xfffd) || (codePoint >= 0x10000 && codePoint <= 0x10ffff);
  }).join("");
  return valid.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&apos;");
}
function normalizeDisplayText(value: unknown): string { return String(value).replace(/[\p{Cc}\p{Cf}]+/gu, " ").replace(/\s+/gu, " ").trim(); }
function html(value: unknown): string { return normalizeDisplayText(value).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;"); }
function markdown(value: unknown): string { return normalizeDisplayText(value).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replace(/([\\`*_[\]{}|])/gu, "\\$1"); }

export function markdownReport(report: DrillReport): string {
  const rows = report.results.map((result) => `| \`${markdown(result.caseId)}\` | ${markdown(result.mode)} | ${markdown(result.status)} | ${markdown(result.findings.map((finding) => finding.ruleId).join(", ") || "-")} |`).join("\n");
  return `# ToolDrill conformance report\n\nArtifact: \`${report.version}\`\n\n- Manifest: \`${markdown(report.manifest.name)}\`\n- Cases: **${report.totals.cases}**\n- Passed: **${report.totals.passed}**\n- Failed: **${report.totals.failed}**\n\n| Case | Mode | Status | Findings |\n|---|---|---|---|\n${rows}\n\n> Results describe only the explicit adapter supplied to this offline harness; they are not a production security or availability proof.\n`;
}

export function junitReport(report: DrillReport): string {
  const cases = report.results.map((result) => {
    const failures = result.findings.map((finding) => `${finding.ruleId}: ${finding.message}${finding.path === undefined ? "" : ` at ${finding.path}`}`).join("\n");
    return `<testcase classname="tooldrill.${xml(result.mode)}" name="${xml(result.caseId)}">${result.status === "fail" ? `<failure message="${xml(result.findings[0]?.ruleId ?? "failure")}">${xml(failures)}</failure>` : ""}<system-out>${xml(result.transcript.join("\n"))}</system-out></testcase>`;
  }).join("");
  return `<?xml version="1.0" encoding="UTF-8"?><testsuite name="${xml(report.manifest.name)}" tests="${report.totals.cases}" failures="${report.totals.failed}">${cases}</testsuite>\n`;
}

function sarifLevel(_finding: Finding): "error" { return "error"; }
export function sarifReport(report: DrillReport) {
  const ruleIds = [...new Set(report.results.flatMap((result) => result.findings.map((finding) => finding.ruleId)))].sort();
  return {
    version: "2.1.0",
    $schema: "https://json.schemastore.org/sarif-2.1.0.json",
    runs: [{
      tool: { driver: { name: "ToolDrill", version: "0.1.0", informationUri: "https://github.com/nripankadas07/tooldrill", rules: ruleIds.map((id) => ({ id, shortDescription: { text: id } })) } },
      results: report.results.flatMap((result) => result.findings.map((finding) => ({ ruleId: finding.ruleId, level: sarifLevel(finding), message: { text: `${result.caseId}: ${finding.message}` }, locations: [{ physicalLocation: { artifactLocation: { uri: report.manifest.uri }, region: { startLine: 1 } }, logicalLocations: [{ name: finding.path ?? result.caseId }] }] }))),
    }],
  };
}

export function htmlReport(report: DrillReport): string {
  const rows = report.results.map((result) => `<tr><td><code>${html(result.caseId)}</code></td><td>${html(result.mode)}</td><td><span class="${html(result.status)}">${html(result.status)}</span></td><td>${html(result.findings.map((finding) => `${finding.ruleId}${finding.path === undefined ? "" : ` ${finding.path}`}`).join(", ") || "-")}</td></tr>`).join("");
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>ToolDrill report</title><style>body{margin:0;background:#07131a;color:#e4f4f4;font:15px system-ui}.wrap{max-width:1050px;margin:auto;padding:42px}.hero,.panel{background:#0f222c;border:1px solid #244452;border-radius:16px;padding:24px;margin:18px 0}.metrics{display:flex;gap:14px;flex-wrap:wrap}.metric{min-width:130px;background:#0a1921;padding:16px;border-radius:12px}.metric b{display:block;font-size:28px}.pass{color:#6ce0a2}.fail{color:#ff918d}table{border-collapse:collapse;width:100%}th,td{text-align:left;padding:10px;border-bottom:1px solid #244452}code{color:#91d7f2}.note{color:#a8bbc2}</style></head><body><main class="wrap"><section class="hero"><h1>ToolDrill</h1><p class="note">Offline manifest conformance report · ${html(report.version)}</p><div class="metrics"><div class="metric"><b>${report.totals.cases}</b>cases</div><div class="metric pass"><b>${report.totals.passed}</b>passed</div><div class="metric fail"><b>${report.totals.failed}</b>failed</div></div></section><section class="panel"><table><thead><tr><th>Case</th><th>Mode</th><th>Status</th><th>Findings</th></tr></thead><tbody>${rows}</tbody></table></section><p class="note">Results describe only the explicit adapter supplied to this offline harness; this is not a production security or availability proof.</p></main></body></html>\n`;
}

export async function writeArtifacts(outDir: string, report: DrillReport): Promise<void> {
  await mkdir(outDir, { recursive: true });
  await Promise.all([
    writeFile(join(outDir, "report.json"), `${JSON.stringify(report, null, 2)}\n`),
    writeFile(join(outDir, "report.md"), markdownReport(report)),
    writeFile(join(outDir, "junit.xml"), junitReport(report)),
    writeFile(join(outDir, "results.sarif"), `${JSON.stringify(sarifReport(report), null, 2)}\n`),
    writeFile(join(outDir, "index.html"), htmlReport(report)),
  ]);
}
