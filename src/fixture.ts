import { MANIFEST_VERSION, type ToolManifest, validate } from "./schema.js";

export const defectiveManifest: ToolManifest = {
  version: MANIFEST_VERSION,
  name: "temperature.convert",
  description: "Offline defective fixture used to prove ToolDrill findings.",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["temperature", "from", "to", "label"],
    properties: {
      temperature: { type: "number", minimum: -273.15, maximum: 1000 },
      from: { type: "string", enum: ["C", "F", "K"] },
      to: { type: "string", enum: ["C", "F", "K"] },
      label: { type: "string", minLength: 1, maxLength: 12, pattern: "^[A-Za-z]+$" },
    },
  },
  outputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["value", "unit", "traceId"],
    properties: {
      value: { type: "number" },
      unit: { type: "string", enum: ["C", "F", "K"] },
      traceId: { type: "string", pattern: "^trace-[0-9]+$" },
    },
  },
};

export type Invocation =
  | { status: "ok"; value: unknown; elapsedMs: number; transcript: string[] }
  | { status: "error"; error: { code: string; message: string }; elapsedMs: number; transcript: string[] }
  | { status: "timeout"; elapsedMs: number; transcript: string[] }
  | { status: "cancelled"; elapsedMs: number; transcript: string[] };

export interface InvocationContext { caseId: string; attempt: number; timeoutMs?: number; cancelled?: boolean }
export interface ToolServer { invoke(args: Record<string, unknown>, context: InvocationContext): Promise<Invocation> }

function celsius(value: number, from: string): number {
  if (from === "F") return (value - 32) * 5 / 9;
  if (from === "K") return value - 273.15;
  return value;
}

function fromCelsius(value: number, to: string): number {
  if (to === "F") return value * 9 / 5 + 32;
  if (to === "K") return value + 273.15;
  return value;
}

export class DefectiveFixtureServer implements ToolServer {
  async invoke(args: Record<string, unknown>, context: InvocationContext): Promise<Invocation> {
    const transcript = [`dispatch:${context.caseId}`, `attempt:${context.attempt}`];
    const inputIssues = validate(defectiveManifest.inputSchema, args);
    if (inputIssues.length > 0) {
      const suffix = context.attempt % 2 === 0 ? "A" : "B";
      transcript.push(`reject:INVALID_INPUT_${suffix}`);
      return { status: "error", error: { code: `INVALID_INPUT_${suffix}`, message: `input rejected variant ${suffix}` }, elapsedMs: 1, transcript };
    }
    if (context.cancelled === true) {
      transcript.push("fault:cancellation-ignored");
      return { status: "ok", value: { value: 0, unit: args.to, traceId: "trace-1" }, elapsedMs: 2, transcript };
    }
    if (context.timeoutMs !== undefined) {
      transcript.push("fault:timeout-ignored");
      return { status: "ok", value: { value: 0, unit: args.to, traceId: "trace-2" }, elapsedMs: context.timeoutMs + 25, transcript };
    }
    const converted = fromCelsius(celsius(args.temperature as number, args.from as string), args.to as string);
    if (args.temperature === 1000) {
      transcript.push("fault:invalid-response-schema");
      return { status: "ok", value: { value: converted, unit: "Rankine" }, elapsedMs: 3, transcript };
    }
    transcript.push("respond:ok");
    return { status: "ok", value: { value: converted, unit: args.to, traceId: "trace-7" }, elapsedMs: 3, transcript };
  }
}
