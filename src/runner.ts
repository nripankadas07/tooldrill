import { firstInvalidPrimitive, generateCases, primitiveShrinkCandidates, type DrillCase } from "./cases.js";
import { type Invocation, type ToolServer } from "./fixture.js";
import { assertSupportedManifest, type ToolManifest, type ValidationIssue, validate } from "./schema.js";

export const RESULT_VERSION = "tooldrill.result/v1" as const;
export interface Finding { ruleId: "input-generator" | "response-schema" | "stable-error" | "timeout" | "cancellation" | "server-error"; message: string; path?: string }
export interface CaseResult {
  version: typeof RESULT_VERSION;
  caseId: string;
  mode: DrillCase["mode"];
  status: "pass" | "fail";
  arguments: Record<string, unknown>;
  inputIssues: ValidationIssue[];
  findings: Finding[];
  transcript: string[];
  shrunkArguments?: Record<string, unknown>;
}
export interface DrillReport {
  version: "tooldrill.report/v1";
  manifest: { version: string; name: string; uri: string };
  deterministic: true;
  totals: { cases: number; passed: number; failed: number };
  results: CaseResult[];
}

function stableError(first: Invocation, second: Invocation): boolean {
  return first.status === "error" && second.status === "error" && first.error.code === second.error.code && first.error.message === second.error.message;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const sortedExpected = [...expected].sort();
  return actual.length === sortedExpected.length && actual.every((key, index) => key === sortedExpected[index]);
}

async function invokeChecked(server: ToolServer, args: Record<string, unknown>, context: Parameters<ToolServer["invoke"]>[1]): Promise<Invocation> {
  const value: unknown = await server.invoke(args, context);
  if (!isRecord(value) || !["ok", "error", "timeout", "cancelled"].includes(String(value.status))) throw new TypeError("adapter returned an invalid invocation");
  if (typeof value.elapsedMs !== "number" || !Number.isFinite(value.elapsedMs) || value.elapsedMs < 0) throw new TypeError("adapter returned an invalid elapsed time");
  if (!Array.isArray(value.transcript) || value.transcript.some((entry) => typeof entry !== "string")) throw new TypeError("adapter returned an invalid transcript");
  if (value.status === "ok" && !exactKeys(value, ["status", "value", "elapsedMs", "transcript"])) throw new TypeError("adapter returned an invalid ok invocation");
  if (value.status === "error") {
    if (!exactKeys(value, ["status", "error", "elapsedMs", "transcript"]) || !isRecord(value.error) || !exactKeys(value.error, ["code", "message"]) || typeof value.error.code !== "string" || typeof value.error.message !== "string") throw new TypeError("adapter returned an invalid error invocation");
  }
  if ((value.status === "timeout" || value.status === "cancelled") && !exactKeys(value, ["status", "elapsedMs", "transcript"])) throw new TypeError("adapter returned an invalid terminal invocation");
  return value as unknown as Invocation;
}

async function shrinkInvalid(manifest: ToolManifest, server: ToolServer, drillCase: DrillCase): Promise<Record<string, unknown> | undefined> {
  const target = firstInvalidPrimitive(manifest, drillCase.arguments);
  if (target === undefined) return undefined;
  let best = structuredClone(drillCase.arguments);
  for (const candidate of primitiveShrinkCandidates(target.value)) {
    const next = { ...best, [target.key]: candidate };
    if (validate(manifest.inputSchema, next).length === 0) continue;
    const [first, second] = await Promise.all([invokeChecked(server, next, { caseId: `${drillCase.id}:shrink`, attempt: 0 }), invokeChecked(server, next, { caseId: `${drillCase.id}:shrink`, attempt: 1 })]);
    if (!stableError(first, second)) {
      best = next;
      break;
    }
  }
  return JSON.stringify(best) === JSON.stringify(drillCase.arguments) ? undefined : best;
}

async function runCase(manifest: ToolManifest, server: ToolServer, drillCase: DrillCase): Promise<CaseResult> {
  const inputIssues = validate(manifest.inputSchema, drillCase.arguments);
  const findings: Finding[] = [];
  const transcript = [`case:${drillCase.id}`, `input-validation:${inputIssues.length}`];
  let shrunkArguments: Record<string, unknown> | undefined;

  try {
    if (drillCase.mode === "invalid") {
      if (inputIssues.length === 0) findings.push({ ruleId: "input-generator", message: "generated invalid case unexpectedly satisfies the schema" });
      const first = await invokeChecked(server, drillCase.arguments, { caseId: drillCase.id, attempt: 0 });
      const second = await invokeChecked(server, drillCase.arguments, { caseId: drillCase.id, attempt: 1 });
      transcript.push(...first.transcript.map((entry) => `first:${entry}`), ...second.transcript.map((entry) => `second:${entry}`));
      if (!stableError(first, second)) {
        findings.push({ ruleId: "stable-error", message: "repeated invalid input did not produce the same error code and message" });
        shrunkArguments = await shrinkInvalid(manifest, server, drillCase);
      }
    } else if (drillCase.mode === "timeout") {
      const invocation = await invokeChecked(server, drillCase.arguments, { caseId: drillCase.id, attempt: 0, timeoutMs: 5 });
      transcript.push(...invocation.transcript, `elapsed:${invocation.elapsedMs}`);
      if (invocation.status !== "timeout") findings.push({ ruleId: "timeout", message: `server returned ${invocation.status} after ${invocation.elapsedMs}ms instead of timing out` });
    } else if (drillCase.mode === "cancellation") {
      const invocation = await invokeChecked(server, drillCase.arguments, { caseId: drillCase.id, attempt: 0, cancelled: true });
      transcript.push(...invocation.transcript);
      if (invocation.status !== "cancelled") findings.push({ ruleId: "cancellation", message: `server returned ${invocation.status} for a pre-cancelled call` });
    } else {
      if (inputIssues.length > 0) findings.push({ ruleId: "input-generator", message: "generated valid case violates the input schema" });
      const invocation = await invokeChecked(server, drillCase.arguments, { caseId: drillCase.id, attempt: 0 });
      transcript.push(...invocation.transcript);
      if (invocation.status !== "ok") findings.push({ ruleId: "server-error", message: `valid input returned ${invocation.status}` });
      else {
        const outputIssues = validate(manifest.outputSchema, invocation.value);
        transcript.push(`output-validation:${outputIssues.length}`);
        findings.push(...outputIssues.map((issue) => ({ ruleId: "response-schema" as const, message: issue.message, path: issue.path })));
      }
    }
  } catch (error: unknown) {
    void error;
    findings.push({ ruleId: "server-error", message: "adapter threw an exception" });
    transcript.push("adapter-error");
  }
  return {
    version: RESULT_VERSION,
    caseId: drillCase.id,
    mode: drillCase.mode,
    status: findings.length === 0 ? "pass" : "fail",
    arguments: drillCase.arguments,
    inputIssues,
    findings,
    transcript,
    ...(shrunkArguments === undefined ? {} : { shrunkArguments }),
  };
}

export async function runDrill(manifest: ToolManifest, server: ToolServer, options: { manifestUri?: string } = {}): Promise<DrillReport> {
  assertSupportedManifest(manifest);
  const cases = generateCases(manifest);
  const results: CaseResult[] = [];
  for (const drillCase of cases) results.push(await runCase(manifest, server, drillCase));
  const failed = results.filter((result) => result.status === "fail").length;
  return { version: "tooldrill.report/v1", manifest: { version: manifest.version, name: manifest.name, uri: options.manifestUri ?? "manifest.json" }, deterministic: true, totals: { cases: results.length, passed: results.length - failed, failed }, results };
}
