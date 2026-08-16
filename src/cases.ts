import {
  MAX_AGGREGATE_CASE_NODES,
  MAX_GENERATED_CASES,
  MAX_GENERATED_CARDINALITY,
  assertAggregateGeneratedCaseBudget,
  assertGeneratedWitness,
  assertSupportedManifest,
  estimateGeneratedCaseCount,
  schemaValueEqual,
  synthesizeString,
  type JsonSchema,
  type ToolManifest,
  validate,
} from "./schema.js";

export type CaseMode = "valid" | "invalid" | "timeout" | "cancellation";
export interface DrillCase {
  id: string;
  mode: CaseMode;
  description: string;
  arguments: Record<string, unknown>;
}

const CASE_TEXT_LIMIT = MAX_GENERATED_CARDINALITY + 1;
const CASE_TEXT = {
  a: "a".repeat(CASE_TEXT_LIMIT),
  A: "A".repeat(CASE_TEXT_LIMIT),
  "0": "0".repeat(CASE_TEXT_LIMIT),
  "!": "!".repeat(CASE_TEXT_LIMIT),
} as const;

function boundedCaseText(character: keyof typeof CASE_TEXT, length: number): string {
  if (!Number.isSafeInteger(length) || length < 0 || length > CASE_TEXT_LIMIT) throw new Error("generated string length is outside deterministic case limits");
  return CASE_TEXT[character].slice(0, length);
}

function without(schema: JsonSchema, key: keyof JsonSchema): JsonSchema {
  const copy = { ...schema };
  delete copy[key];
  return copy;
}

function cloneGeneratedWitness<T>(value: T, label: string): T {
  assertGeneratedWitness(value, label);
  return structuredClone(value);
}

function valueFor(schema: JsonSchema, edge: "minimum" | "maximum" = "minimum"): unknown {
  if (Object.hasOwn(schema, "const")) return cloneGeneratedWitness(schema.const, "const witness");
  if (schema.enum !== undefined && schema.enum.length > 0) {
    const valid = schema.enum.filter((entry) => validate(without(schema, "enum"), entry).length === 0);
    const selected = edge === "minimum" ? valid[0] : valid.at(-1);
    if (selected !== undefined) return cloneGeneratedWitness(selected, "enum witness");
  }
  switch (schema.type) {
    case "object": return Object.fromEntries(Object.keys(schema.properties ?? {}).sort().filter((key) => (schema.required ?? []).includes(key)).map((key) => [key, valueFor((schema.properties as Record<string, JsonSchema>)[key] as JsonSchema, edge)]));
    case "array": return Array.from({ length: edge === "minimum" ? (schema.minItems ?? 0) : (schema.maxItems ?? Math.max(1, schema.minItems ?? 0)) }, () => valueFor(schema.items ?? {}, edge));
    case "string": return synthesizeString(schema, edge);
    case "number": {
      if (edge === "minimum") return schema.minimum ?? (schema.maximum !== undefined && schema.maximum < 0 ? schema.maximum : 0);
      return schema.maximum ?? (schema.minimum !== undefined && schema.minimum > 1 ? schema.minimum : 1);
    }
    case "integer": {
      if (edge === "minimum") return Math.ceil(schema.minimum ?? (schema.maximum !== undefined && schema.maximum < 0 ? schema.maximum : 0));
      return Math.floor(schema.maximum ?? (schema.minimum !== undefined && schema.minimum > 1 ? schema.minimum : 1));
    }
    case "boolean": return edge === "maximum";
    case "null": return null;
    default: return null;
  }
}

function wrongType(schema: JsonSchema): unknown {
  if (schema.type === "string") return 7;
  if (schema.type === "number" || schema.type === "integer") return "not-a-number";
  if (schema.type === "boolean") return "true";
  if (schema.type === "array") return {};
  return "wrong-type";
}

function constViolation(value: unknown): unknown {
  if (typeof value === "string") return `${value}__tooldrill_invalid_const__`;
  if (typeof value === "number") return value === 0 ? 1 : 0;
  if (typeof value === "boolean") return !value;
  if (value === null) return "__tooldrill_invalid_const__";
  if (Array.isArray(value)) return [...value, "__tooldrill_invalid_const__"];
  if (typeof value === "object") return { ...(value as Record<string, unknown>), __tooldrill_invalid_const__: true };
  return "__tooldrill_invalid_const__";
}

function candidateViolating(schema: JsonSchema, keyword: "const" | "enum"): unknown | undefined {
  const relaxed = without(schema, keyword);
  const candidates: unknown[] = [
    valueFor(relaxed), valueFor(relaxed, "maximum"), "__tooldrill_invalid__", "", "a", "A", "0", 0, 1, -1, false, true, null, [], [null], {}, { unexpected: true },
  ];
  if (keyword === "const" && schema.const !== undefined) candidates.unshift(constViolation(schema.const));
  for (const candidate of candidates) {
    if (validate(relaxed, candidate).length > 0) continue;
    if (keyword === "const" && !schemaValueEqual(candidate, schema.const)) return cloneGeneratedWitness(candidate, "generated const-violation witness");
    if (keyword === "enum" && !(schema.enum ?? []).some((entry) => schemaValueEqual(entry, candidate))) return cloneGeneratedWitness(candidate, "generated enum-violation witness");
  }
  return undefined;
}

function invalidPatternValue(schema: JsonSchema): string | undefined {
  const relaxed = without(schema, "pattern");
  const minimum = schema.minLength ?? 0;
  const maximum = schema.maxLength ?? Math.max(minimum, 32);
  const lengths = [...new Set([minimum, Math.min(maximum, Math.max(minimum, 1)), Math.min(maximum, Math.max(minimum, 4)), maximum])];
  const candidates = ["\n", "123!", "__invalid_pattern__", ...lengths.flatMap((length) => [
    boundedCaseText("a", length), boundedCaseText("A", length), boundedCaseText("0", length), boundedCaseText("!", length),
  ])];
  return candidates.find((candidate) => validate(relaxed, candidate).length === 0 && validate(schema, candidate).some((issue) => issue.keyword === "pattern"));
}

type ValuePath = Array<string | number>;

function cloneWith(root: Record<string, unknown>, path: ValuePath, value: unknown): Record<string, unknown> {
  const copy = cloneGeneratedWitness(root, `generated ${formatPath(path)} context`);
  const replacement = cloneGeneratedWitness(value, `generated ${formatPath(path)} value`);
  if (path.length === 0) {
    assertGeneratedWitness(replacement, "generated root witness");
    return replacement as Record<string, unknown>;
  }
  let current: unknown = copy;
  for (let index = 0; index < path.length - 1; index += 1) {
    const segment = path[index];
    if (typeof segment === "number" && Array.isArray(current)) current = current[segment];
    else if (typeof segment === "string" && current !== null && typeof current === "object") current = (current as Record<string, unknown>)[segment];
    else throw new Error(`cannot set generated path ${formatPath(path)}`);
  }
  const final = path.at(-1);
  if (typeof final === "number" && Array.isArray(current)) current[final] = replacement;
  else if (typeof final === "string" && current !== null && typeof current === "object") Object.defineProperty(current, final, { value: replacement, enumerable: true, configurable: true, writable: true });
  else throw new Error(`cannot set generated path ${formatPath(path)}`);
  assertGeneratedWitness(copy, `generated ${formatPath(path)} witness`);
  return copy;
}

function omitAtPath(current: unknown, path: ValuePath, index: number): unknown {
  const segment = path[index];
  if (segment === undefined) throw new Error(`cannot omit generated path ${formatPath(path)}`);
  const final = index === path.length - 1;
  if (typeof segment === "number" && Array.isArray(current)) {
    if (!Number.isSafeInteger(segment) || segment < 0 || segment >= current.length) throw new Error(`cannot omit generated path ${formatPath(path)}`);
    if (final) return [...current.slice(0, segment), ...current.slice(segment + 1)];
    return current.map((entry, childIndex) => childIndex === segment ? omitAtPath(entry, path, index + 1) : entry);
  }
  if (typeof segment === "string" && current !== null && typeof current === "object" && !Array.isArray(current)) {
    const entries = Object.entries(current);
    if (!Object.hasOwn(current, segment)) throw new Error(`cannot omit generated path ${formatPath(path)}`);
    if (final) return Object.fromEntries(entries.filter(([key]) => key !== segment));
    return Object.fromEntries(entries.map(([key, entry]) => [key, key === segment ? omitAtPath(entry, path, index + 1) : entry]));
  }
  throw new Error(`cannot omit generated path ${formatPath(path)}`);
}

function cloneWithout(root: Record<string, unknown>, path: ValuePath): Record<string, unknown> {
  const copy = cloneGeneratedWitness(root, `generated ${formatPath(path)} context`);
  const result = omitAtPath(copy, path, 0) as Record<string, unknown>;
  assertGeneratedWitness(result, `generated ${formatPath(path)} omission witness`);
  return result;
}

function formatPath(path: ValuePath): string {
  return path.map((segment, index) => {
    if (typeof segment === "number") return `[${segment}]`;
    if (/^[A-Za-z0-9_-]+$/u.test(segment)) return `${index === 0 ? "" : "."}${segment}`;
    return `[${JSON.stringify(segment)}]`;
  }).join("") || "root";
}

export function generateCases(manifest: ToolManifest): DrillCase[] {
  assertSupportedManifest(manifest);
  const baseline = valueFor(manifest.inputSchema, "minimum") as Record<string, unknown>;
  const baselineMeasurement = assertGeneratedWitness(baseline, "generated baseline witness");
  assertAggregateGeneratedCaseBudget(estimateGeneratedCaseCount(manifest.inputSchema), baselineMeasurement.nodes);
  const baselineIssues = validate(manifest.inputSchema, baseline);
  if (baselineIssues.length > 0) throw new Error(`cannot generate a valid baseline: ${baselineIssues.map((issue) => `${issue.path} ${issue.keyword}`).join(", ")}`);
  let aggregateCaseNodes = baselineMeasurement.nodes;
  const cases: DrillCase[] = [{ id: "valid.baseline", mode: "valid", description: "minimum valid object", arguments: baseline }];
  const ids = new Set(["valid.baseline"]);
  const accountCase = (id: string, args: Record<string, unknown>): void => {
    const nodes = assertGeneratedWitness(args, `generated case ${id}`).nodes;
    aggregateCaseNodes = aggregateCaseNodes > MAX_AGGREGATE_CASE_NODES - nodes
      ? MAX_AGGREGATE_CASE_NODES + 1
      : aggregateCaseNodes + nodes;
    if (aggregateCaseNodes > MAX_AGGREGATE_CASE_NODES) throw new Error(`generated cases exceed maximum aggregate witness size ${MAX_AGGREGATE_CASE_NODES}`);
  };
  const add = (id: string, mode: "valid" | "invalid", description: string, args: Record<string, unknown>, keyword?: string): void => {
    if (cases.length >= MAX_GENERATED_CASES) throw new Error(`generated case count exceeds ${MAX_GENERATED_CASES}`);
    if (ids.has(id)) throw new Error(`duplicate generated case id: ${id}`);
    accountCase(id, args);
    const issues = validate(manifest.inputSchema, args);
    if (mode === "valid" && issues.length > 0) throw new Error(`generated valid case ${id} is invalid`);
    if (mode === "invalid" && (issues.length === 0 || (keyword !== undefined && !issues.some((issue) => issue.keyword === keyword)))) throw new Error(`generated invalid case ${id} does not violate ${keyword ?? "the schema"}`);
    ids.add(id);
    cases.push({ id, mode, description, arguments: args });
  };

  const visitNode = (schema: JsonSchema, path: ValuePath, context: Record<string, unknown>): void => {
    const label = formatPath(path);
    const minimumValue = valueFor(schema, "minimum");
    const nodeContext = cloneWith(context, path, minimumValue);
    const maximumValue = valueFor(schema, "maximum");
    const hasDeclaredUpper = schema.maximum !== undefined || schema.maxLength !== undefined || schema.maxItems !== undefined || (schema.enum?.length ?? 0) > 1 || schema.type === "boolean";
    if (hasDeclaredUpper && !schemaValueEqual(minimumValue, maximumValue)) add(`valid.${label}.maximum`, "valid", `${label} at a maximum valid boundary`, cloneWith(nodeContext, path, maximumValue));
    if (schema.type !== undefined) add(`invalid.${label}.type`, "invalid", `${label} with a wrong type`, cloneWith(nodeContext, path, wrongType(schema)), "type");
    if (schema.const !== undefined) {
      const candidate = candidateViolating(schema, "const");
      if (candidate !== undefined) add(`invalid.${label}.const`, "invalid", `${label} violates const`, cloneWith(nodeContext, path, candidate), "const");
    }
    if (schema.enum !== undefined) {
      const candidate = candidateViolating(schema, "enum");
      if (candidate !== undefined) add(`invalid.${label}.enum`, "invalid", `${label} is outside enum`, cloneWith(nodeContext, path, candidate), "enum");
    }
    if (schema.minimum !== undefined) {
      const candidate = schema.type === "integer" ? Math.ceil(schema.minimum) - 1 : schema.minimum - Math.max(1, Math.abs(schema.minimum) * Number.EPSILON * 2);
      add(`invalid.${label}.below-minimum`, "invalid", `${label} is below minimum`, cloneWith(nodeContext, path, candidate), "minimum");
    }
    if (schema.maximum !== undefined) {
      const candidate = schema.type === "integer" ? Math.floor(schema.maximum) + 1 : schema.maximum + Math.max(1, Math.abs(schema.maximum) * Number.EPSILON * 2);
      add(`invalid.${label}.above-maximum`, "invalid", `${label} is above maximum`, cloneWith(nodeContext, path, candidate), "maximum");
    }
    if (schema.minLength !== undefined && schema.minLength > 0) add(`invalid.${label}.too-short`, "invalid", `${label} is below minLength`, cloneWith(nodeContext, path, boundedCaseText("a", schema.minLength - 1)), "minLength");
    if (schema.maxLength !== undefined) add(`invalid.${label}.too-long`, "invalid", `${label} is above maxLength`, cloneWith(nodeContext, path, boundedCaseText("a", schema.maxLength + 1)), "maxLength");
    if (schema.pattern !== undefined) {
      const candidate = invalidPatternValue(schema);
      if (candidate !== undefined) add(`invalid.${label}.pattern`, "invalid", `${label} violates pattern`, cloneWith(nodeContext, path, candidate), "pattern");
    }
    if (schema.minItems !== undefined && schema.minItems > 0) add(`invalid.${label}.below-minItems`, "invalid", `${label} is below minItems`, cloneWith(nodeContext, path, Array.from({ length: schema.minItems - 1 }, () => valueFor(schema.items ?? {}))), "minItems");
    if (schema.maxItems !== undefined) add(`invalid.${label}.above-maxItems`, "invalid", `${label} is above maxItems`, cloneWith(nodeContext, path, Array.from({ length: schema.maxItems + 1 }, () => valueFor(schema.items ?? {}))), "maxItems");

    if (schema.type === "object") {
      const objectContext = cloneWith(nodeContext, path, valueFor(schema));
      for (const required of [...(schema.required ?? [])].sort()) add(`invalid.${formatPath([...path, required])}.required`, "invalid", `${formatPath([...path, required])} omitted`, cloneWithout(objectContext, [...path, required]), "required");
      if (schema.additionalProperties === false) {
        let unexpected = "unexpected";
        while (schema.properties !== undefined && Object.hasOwn(schema.properties, unexpected)) unexpected = `_${unexpected}`;
        add(`invalid.${label}.additional-property`, "invalid", `${label} has an unexpected property`, cloneWith(objectContext, [...path, unexpected], true), "additionalProperties");
      }
      for (const key of Object.keys(schema.properties ?? {}).sort()) visitNode((schema.properties as Record<string, JsonSchema>)[key] as JsonSchema, [...path, key], objectContext);
    } else if (schema.type === "array" && schema.items !== undefined && (schema.maxItems ?? 1) > 0) {
      const length = Math.max(1, schema.minItems ?? 0);
      const arrayContext = cloneWith(nodeContext, path, Array.from({ length }, () => valueFor(schema.items as JsonSchema)));
      visitNode(schema.items, [...path, 0], arrayContext);
    }
  };

  const rootContext = cloneGeneratedWitness(baseline, "generated root context");
  for (const required of [...(manifest.inputSchema.required ?? [])].sort()) add(`invalid.${required}.required`, "invalid", `${required} omitted`, cloneWithout(rootContext, [required]), "required");
  if (manifest.inputSchema.additionalProperties === false) {
    let unexpected = "unexpected";
    while (manifest.inputSchema.properties !== undefined && Object.hasOwn(manifest.inputSchema.properties, unexpected)) unexpected = `_${unexpected}`;
    add("invalid.root.additional-property", "invalid", "root has an unexpected property", cloneWith(rootContext, [unexpected], true), "additionalProperties");
  }
  for (const key of Object.keys(manifest.inputSchema.properties ?? {}).sort()) visitNode((manifest.inputSchema.properties as Record<string, JsonSchema>)[key] as JsonSchema, [key], rootContext);
  if (cases.length + 2 > MAX_GENERATED_CASES) throw new Error(`generated case count exceeds ${MAX_GENERATED_CASES}`);
  accountCase("protocol.timeout", baseline);
  accountCase("protocol.cancellation", baseline);
  cases.push({ id: "protocol.timeout", mode: "timeout", description: "server must honor the declared timeout", arguments: baseline });
  cases.push({ id: "protocol.cancellation", mode: "cancellation", description: "server must honor pre-dispatch cancellation", arguments: baseline });
  return cases;
}

export function primitiveShrinkCandidates(value: unknown): unknown[] {
  if (typeof value === "string") return [...new Set(["", value.slice(0, 1), value.slice(0, Math.floor(value.length / 2))])];
  if (typeof value === "number" && Number.isFinite(value)) return [...new Set([0, Math.sign(value), Math.trunc(value / 2)])];
  if (typeof value === "boolean") return [false];
  if (value === null) return [null];
  return [];
}

export function firstInvalidPrimitive(manifest: ToolManifest, args: Record<string, unknown>): { key: string; value: unknown } | undefined {
  const issues = validate(manifest.inputSchema, args);
  for (const issue of issues) {
    const match = /^\$\.([A-Za-z0-9_-]+)$/u.exec(issue.path);
    if (match?.[1] !== undefined && ["string", "number", "boolean"].includes(typeof args[match[1]])) return { key: match[1], value: args[match[1]] };
  }
  return undefined;
}
