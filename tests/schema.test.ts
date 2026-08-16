import assert from "node:assert/strict";
import test from "node:test";
import { generateCases, primitiveShrinkCandidates } from "../src/cases.js";
import { defectiveManifest } from "../src/fixture.js";
import {
  MAX_AGGREGATE_LITERAL_NODES,
  MAX_AGGREGATE_LITERAL_STRING_CODE_POINTS,
  MAX_GENERATED_NODES,
  MAX_JSON_STRING_CODE_POINTS,
  MAX_JSON_VALUE_DEPTH,
  MAX_JSON_VALUE_STRING_CODE_POINTS,
  MAX_OBJECT_PROPERTIES,
  MAX_PATTERN_INPUT_LENGTH,
  MANIFEST_VERSION,
  assertSupportedManifest,
  measureJsonValue,
  synthesizeString,
  type JsonSchema,
  type ToolManifest,
  validate,
} from "../src/schema.js";

function manifestWithOutput(outputSchema: JsonSchema): ToolManifest {
  return {
    version: MANIFEST_VERSION,
    name: "literal-budget-regression",
    description: "adversarial literal resource-budget fixture",
    inputSchema: { type: "object", properties: {}, required: [], additionalProperties: false },
    outputSchema,
  };
}

function arrayLiteralWithNodes(nodes: number, marker: unknown = null): unknown[] {
  assert.ok(nodes >= 1);
  const value = Array.from({ length: nodes - 1 }, () => null as unknown);
  if (value.length > 0) value[0] = marker;
  return value;
}

test("schema validator accepts boundaries and rejects type, enum, pattern, and extras", () => {
  assert.deepEqual(validate(defectiveManifest.inputSchema, { temperature: -273.15, from: "C", to: "K", label: "a" }), []);
  const issues = validate(defectiveManifest.inputSchema, { temperature: "cold", from: "X", to: "K", label: "123!", extra: true });
  assert.deepEqual([...new Set(issues.map((issue) => issue.keyword))].sort(), ["additionalProperties", "enum", "pattern", "type"]);
});

test("string lengths use Unicode code points", () => {
  assert.deepEqual(validate({ type: "string", minLength: 1, maxLength: 1 }, "😀"), []);
  assert.ok(validate({ type: "string", maxLength: 1 }, "😀a").some((issue) => issue.keyword === "maxLength"));
  assert.equal(synthesizeString({ type: "string", pattern: "^😀$", minLength: 1, maxLength: 1 }), "😀");
});

test("pattern validation rejects ambiguous repetition and bounds evaluated inputs", () => {
  const unsafe = structuredClone(defectiveManifest);
  const label = unsafe.inputSchema.properties?.label;
  assert.ok(label);
  label.pattern = "^a+a+$";
  assert.throws(() => assertSupportedManifest(unsafe), /more than one variable repetition/u);
  assert.deepEqual(validate({ type: "string", pattern: "^a+a+$" }, `${"a".repeat(10_000)}b`), [{
    path: "$",
    keyword: "pattern",
    message: "manifest contains an unsupported regex",
  }]);
  assert.deepEqual(validate({ type: "string", pattern: "^a+$" }, "a".repeat(MAX_PATTERN_INPUT_LENGTH + 1)), [{
    path: "$",
    keyword: "pattern",
    message: `value exceeds the ${MAX_PATTERN_INPUT_LENGTH}-code-point pattern evaluation limit`,
  }]);
});

test("case generator is deterministic and covers boundary, invalid, timeout, and cancellation modes", () => {
  const first = generateCases(defectiveManifest);
  assert.deepEqual(first, generateCases(defectiveManifest));
  assert.equal(new Set(first.map((item) => item.id)).size, first.length);
  assert.deepEqual([...new Set(first.map((item) => item.mode))].sort(), ["cancellation", "invalid", "timeout", "valid"]);
  assert.deepEqual(primitiveShrinkCandidates("abcdefgh"), ["", "a", "abcd"]);
  assert.deepEqual(primitiveShrinkCandidates(1000), [0, 1, 500]);
});

test("case generator covers array cardinality and const violations", () => {
  const manifest: ToolManifest = {
    version: MANIFEST_VERSION,
    name: "array-and-const",
    description: "boundary regression fixture",
    inputSchema: {
      type: "object",
      required: ["tags", "mode"],
      properties: {
        tags: { type: "array", items: { type: "string" }, minItems: 2, maxItems: 3 },
        mode: { type: "string", const: "strict" },
      },
    },
    outputSchema: { type: "object" },
  };
  const cases = generateCases(manifest);
  const below = cases.find((item) => item.id === "invalid.tags.below-minItems");
  const above = cases.find((item) => item.id === "invalid.tags.above-maxItems");
  const constant = cases.find((item) => item.id === "invalid.mode.const");
  assert.equal((below?.arguments.tags as unknown[]).length, 1);
  assert.equal((above?.arguments.tags as unknown[]).length, 4);
  assert.ok(validate(manifest.inputSchema, below?.arguments).some((issue) => issue.keyword === "minItems"));
  assert.ok(validate(manifest.inputSchema, above?.arguments).some((issue) => issue.keyword === "maxItems"));
  assert.ok(validate(manifest.inputSchema, constant?.arguments).some((issue) => issue.keyword === "const"));
});

test("non-finite values and schema boundaries are rejected", () => {
  for (const value of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
    assert.deepEqual(validate({ type: "number" }, value), [{ path: "$", keyword: "type", message: "expected a finite JSON number" }]);
  }
  const manifest = structuredClone(defectiveManifest);
  const temperature = manifest.inputSchema.properties?.temperature;
  assert.ok(temperature);
  temperature.minimum = Number.NaN;
  assert.throws(() => assertSupportedManifest(manifest), /inputSchema\.properties\.temperature\.minimum must be finite/u);
  assert.ok(validate({ type: "object" }, new Date("2026-01-01T00:00:00.000Z")).some((issue) => issue.keyword === "type"));
  const sparse: unknown[] = [];
  sparse.length = 1;
  assert.ok(validate({ type: "array" }, sparse).some((issue) => issue.keyword === "type"));
  const cycle: Record<string, unknown> = {};
  cycle.self = cycle;
  assert.ok(validate({ type: "object" }, cycle).some((issue) => issue.keyword === "type"));
});

test("manifest validation fails closed on unsupported keywords, types, regexes, and contradictions", () => {
  const mutate = (fn: (manifest: Record<string, unknown>) => void): ToolManifest => {
    const manifest = structuredClone(defectiveManifest) as unknown as Record<string, unknown>;
    fn(manifest);
    return manifest as unknown as ToolManifest;
  };
  assert.throws(() => assertSupportedManifest(mutate((manifest) => { (manifest.inputSchema as Record<string, unknown>).oneOf = [{ type: "object" }]; })), /oneOf is unsupported/u);
  assert.throws(() => assertSupportedManifest(mutate((manifest) => { ((manifest.inputSchema as { properties: Record<string, unknown> }).properties.label as Record<string, unknown>).$ref = "#/$defs/x"; })), /\$ref is unsupported/u);
  assert.throws(() => assertSupportedManifest(mutate((manifest) => { ((manifest.inputSchema as { properties: Record<string, unknown> }).properties.label as Record<string, unknown>).type = "wat"; })), /type is unsupported/u);
  assert.throws(() => assertSupportedManifest(mutate((manifest) => { ((manifest.inputSchema as { properties: Record<string, unknown> }).properties.label as Record<string, unknown>).pattern = "["; })), /pattern is unsupported/u);
  assert.throws(() => assertSupportedManifest(mutate((manifest) => { ((manifest.inputSchema as { properties: Record<string, unknown> }).properties.label as Record<string, unknown>).minLength = -1; })), /nonnegative safe integer/u);
  assert.throws(() => assertSupportedManifest(mutate((manifest) => {
    const label = (manifest.inputSchema as { properties: Record<string, unknown> }).properties.label as Record<string, unknown>;
    label.minLength = 5; label.maxLength = 2;
  })), /contradictory string bounds/u);
  assert.throws(() => assertSupportedManifest(mutate((manifest) => { ((manifest.inputSchema as { properties: Record<string, unknown> }).properties.label as Record<string, unknown>).enum = []; })), /nonempty dense array/u);
  assert.throws(() => assertSupportedManifest(mutate((manifest) => { (manifest.inputSchema as Record<string, unknown>).required = ["missing"]; })), /references missing property/u);
  assert.throws(() => assertSupportedManifest(mutate((manifest) => {
    const temperature = (manifest.inputSchema as { properties: Record<string, unknown> }).properties.temperature as Record<string, unknown>;
    temperature.type = "integer"; temperature.minimum = 0.5; temperature.maximum = 0.5;
  })), /no integer/u);
  assert.throws(() => assertSupportedManifest(mutate((manifest) => {
    (manifest.inputSchema as Record<string, unknown>).properties = {
      nested: { type: "array", maxItems: 10_000, items: { type: "array", maxItems: 10_000, items: { type: "null" } } },
    };
    (manifest.inputSchema as Record<string, unknown>).required = ["nested"];
  })), /maximum deterministic witness size/u);
});

test("manifest validation rejects sparse and extended schema arrays", () => {
  const sparseRequired: string[] = [];
  sparseRequired.length = 1;
  const requiredManifest = structuredClone(defectiveManifest);
  requiredManifest.inputSchema.required = sparseRequired;
  assert.throws(() => assertSupportedManifest(requiredManifest), /required must contain a dense array/u);

  const extendedEnum = ["safe"] as string[] & { metadata?: string };
  extendedEnum.metadata = "not-json-schema-array-data";
  const enumManifest = structuredClone(defectiveManifest);
  const label = enumManifest.inputSchema.properties?.label;
  assert.ok(label);
  label.enum = extendedEnum;
  assert.throws(() => assertSupportedManifest(enumManifest), /enum must be a nonempty dense array/u);
});

test("wide and aggregate-expensive manifests fail with controlled resource errors", () => {
  const wide = structuredClone(defectiveManifest);
  wide.inputSchema.required = [];
  wide.inputSchema.properties = Object.fromEntries(
    Array.from({ length: MAX_OBJECT_PROPERTIES + 1 }, (_, index) => [`p${index}`, { type: "string" as const }]),
  );
  assert.throws(() => assertSupportedManifest(wide), /maximum property count/u);

  const aggregate = structuredClone(defectiveManifest);
  aggregate.inputSchema.properties = Object.fromEntries(
    Array.from({ length: 24 }, (_, index) => [`items${index}`, { type: "array" as const, minItems: 1_000, maxItems: 1_000, items: { type: "null" as const } }]),
  );
  aggregate.inputSchema.required = Object.keys(aggregate.inputSchema.properties);
  assert.throws(() => assertSupportedManifest(aggregate), /maximum aggregate generated witness size/u);
});

test("validator uses own properties for required and additionalProperties", () => {
  const schema = { type: "object" as const, properties: {}, required: ["toString"], additionalProperties: false };
  assert.ok(validate(schema, {}).some((issue) => issue.keyword === "required"));
  assert.ok(validate({ ...schema, required: [] }, JSON.parse('{"toString":"unexpected"}')).some((issue) => issue.keyword === "additionalProperties"));
  assert.ok(validate({ ...schema, required: [] }, JSON.parse('{"constructor":"unexpected"}')).some((issue) => issue.keyword === "additionalProperties"));
});

test("generator produces correctly classified pattern, integer, enum, and nested cases", () => {
  const manifest: ToolManifest = {
    version: MANIFEST_VERSION,
    name: "nested-generator",
    description: "adversarial generator regression",
    inputSchema: {
      type: "object",
      required: ["digits", "count", "mode", "config"],
      additionalProperties: false,
      properties: {
        digits: { type: "string", pattern: "^[0-9]+$", minLength: 1, maxLength: 4 },
        count: { type: "integer", minimum: 0.5, maximum: 3.5 },
        mode: { type: "string", enum: ["__invalid_enum__", "safe"] },
        config: {
          type: "object",
          required: ["label"],
          additionalProperties: false,
          properties: { label: { type: "string", pattern: "^[A-Z]{2}$", minLength: 2, maxLength: 2 } },
        },
      },
    },
    outputSchema: { type: "object" },
  };
  assertSupportedManifest(manifest);
  const cases = generateCases(manifest);
  for (const drillCase of cases) {
    const issues = validate(manifest.inputSchema, drillCase.arguments);
    if (drillCase.mode === "valid") assert.deepEqual(issues, [], drillCase.id);
    if (drillCase.mode === "invalid") assert.ok(issues.length > 0, drillCase.id);
  }
  assert.equal((cases.find((item) => item.id === "valid.baseline")?.arguments.count), 1);
  assert.ok(cases.some((item) => item.id === "invalid.digits.pattern"));
  assert.ok(cases.some((item) => item.id === "invalid.mode.enum"));
  assert.ok(cases.some((item) => item.id === "invalid.config.label.pattern"));
  assert.ok(cases.some((item) => item.id === "invalid.config.label.required"));
  assert.ok(cases.some((item) => item.id === "invalid.config.additional-property"));
});

test("const and enum literals enforce exact 50,000-node boundaries", () => {
  const exact = arrayLiteralWithNodes(MAX_GENERATED_NODES);
  const over = arrayLiteralWithNodes(MAX_GENERATED_NODES + 1);

  assert.doesNotThrow(() => assertSupportedManifest(manifestWithOutput({ type: "array", const: exact })));
  assert.throws(
    () => assertSupportedManifest(manifestWithOutput({ type: "array", const: over })),
    new RegExp(`maximum JSON value node count ${MAX_GENERATED_NODES}`, "u"),
  );
  assert.doesNotThrow(() => assertSupportedManifest(manifestWithOutput({ type: "array", enum: [exact] })));
  assert.throws(
    () => assertSupportedManifest(manifestWithOutput({ type: "array", enum: [over] })),
    new RegExp(`maximum JSON value node count ${MAX_GENERATED_NODES}`, "u"),
  );
});

test("literal measurement is iterative and rejects cycles, sparse arrays, non-plain objects, and non-finite numbers", () => {
  let deep: unknown = null;
  for (let index = 0; index < 10_000; index += 1) deep = [deep];
  assert.throws(
    () => assertSupportedManifest(manifestWithOutput({ type: "array", const: deep })),
    (error: unknown) => error instanceof Error
      && !(error instanceof RangeError)
      && error.message.includes(`maximum JSON value depth ${MAX_JSON_VALUE_DEPTH}`),
  );

  const cycle: Record<string, unknown> = {};
  cycle.self = cycle;
  const sparse: unknown[] = [];
  sparse.length = 1;
  for (const [value, message] of [
    [cycle, /cycle/u],
    [sparse, /sparse or extended array/u],
    [new Date("2026-08-16T00:00:00.000Z"), /non-plain object/u],
    [Number.POSITIVE_INFINITY, /non-finite number/u],
  ] as const) {
    assert.throws(() => measureJsonValue(value), message);
  }
});

test("aggregate enum literal-node budgets accept the exact limit and reject the next value", () => {
  const values = Array.from({ length: (MAX_AGGREGATE_LITERAL_NODES / MAX_GENERATED_NODES) + 1 }, (_, index) => (
    arrayLiteralWithNodes(MAX_GENERATED_NODES, index)
  ));
  const exactCount = MAX_AGGREGATE_LITERAL_NODES / MAX_GENERATED_NODES;
  assert.equal(Number.isInteger(exactCount), true);
  assert.doesNotThrow(() => assertSupportedManifest(manifestWithOutput({ type: "array", enum: values.slice(0, exactCount) })));
  assert.throws(
    () => assertSupportedManifest(manifestWithOutput({ type: "array", enum: values })),
    new RegExp(`aggregate literal node budget ${MAX_AGGREGATE_LITERAL_NODES}`, "u"),
  );
});

test("literal string budgets cover individual, per-value aggregate, and manifest aggregate boundaries", () => {
  const exactString = "a".repeat(MAX_JSON_STRING_CODE_POINTS);
  assert.doesNotThrow(() => assertSupportedManifest(manifestWithOutput({ type: "string", const: exactString })));
  assert.throws(
    () => assertSupportedManifest(manifestWithOutput({ type: "string", const: `${exactString}a` })),
    new RegExp(`string longer than ${MAX_JSON_STRING_CODE_POINTS}`, "u"),
  );

  const aggregateExact = [
    "a".repeat(MAX_JSON_STRING_CODE_POINTS),
    "b".repeat(MAX_JSON_STRING_CODE_POINTS),
    "c".repeat(MAX_JSON_VALUE_STRING_CODE_POINTS - (2 * MAX_JSON_STRING_CODE_POINTS)),
  ];
  assert.doesNotThrow(() => assertSupportedManifest(manifestWithOutput({ type: "array", const: aggregateExact })));
  const aggregateOver = [...aggregateExact.slice(0, 2), `${aggregateExact[2]}c`];
  assert.throws(
    () => assertSupportedManifest(manifestWithOutput({ type: "array", const: aggregateOver })),
    new RegExp(`aggregate string budget ${MAX_JSON_VALUE_STRING_CODE_POINTS}`, "u"),
  );

  const stringsPerManifest = MAX_AGGREGATE_LITERAL_STRING_CODE_POINTS / MAX_JSON_STRING_CODE_POINTS;
  assert.equal(Number.isInteger(stringsPerManifest), true);
  const manifestStrings = Array.from({ length: stringsPerManifest + 1 }, (_, index) => (
    `${String.fromCodePoint(0x41 + index)}${"x".repeat(MAX_JSON_STRING_CODE_POINTS - 1)}`
  ));
  assert.doesNotThrow(() => assertSupportedManifest(manifestWithOutput({ type: "string", enum: manifestStrings.slice(0, stringsPerManifest) })));
  assert.throws(
    () => assertSupportedManifest(manifestWithOutput({ type: "string", enum: manifestStrings })),
    new RegExp(`aggregate literal string budget ${MAX_AGGREGATE_LITERAL_STRING_CODE_POINTS}`, "u"),
  );
});

test("aggregate case estimates include actual const witnesses with saturating arithmetic", () => {
  const literal = arrayLiteralWithNodes(12_000);
  const properties = Object.fromEntries(Array.from({ length: 4 }, (_, index) => [
    `literal${index}`,
    { type: "array" as const, const: literal, items: { type: "null" as const } },
  ]));
  const manifest: ToolManifest = {
    version: MANIFEST_VERSION,
    name: "aggregate-witness-budget",
    description: "case count multiplied by a large baseline",
    inputSchema: { type: "object", properties, required: Object.keys(properties) },
    outputSchema: { type: "null" },
  };
  assert.throws(() => assertSupportedManifest(manifest), /maximum aggregate generated witness size/u);
});

test("generated const-violation witnesses are bounded before a whole-case clone", () => {
  const literal = arrayLiteralWithNodes(MAX_GENERATED_NODES - 1);
  const manifest: ToolManifest = {
    version: MANIFEST_VERSION,
    name: "generated-witness-boundary",
    description: "baseline fits exactly but its const violation does not",
    inputSchema: {
      type: "object",
      properties: { literal: { type: "array", const: literal } },
      required: ["literal"],
    },
    outputSchema: { type: "null" },
  };
  assert.doesNotThrow(() => assertSupportedManifest(manifest));
  assert.throws(
    () => generateCases(manifest),
    new RegExp(`maximum JSON value node count ${MAX_GENERATED_NODES}`, "u"),
  );
});
