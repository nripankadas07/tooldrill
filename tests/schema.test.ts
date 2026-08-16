import assert from "node:assert/strict";
import test from "node:test";
import { generateCases, primitiveShrinkCandidates } from "../src/cases.js";
import { defectiveManifest } from "../src/fixture.js";
import { MANIFEST_VERSION, assertSupportedManifest, type ToolManifest, validate } from "../src/schema.js";

test("schema validator accepts boundaries and rejects type, enum, pattern, and extras", () => {
  assert.deepEqual(validate(defectiveManifest.inputSchema, { temperature: -273.15, from: "C", to: "K", label: "a" }), []);
  const issues = validate(defectiveManifest.inputSchema, { temperature: "cold", from: "X", to: "K", label: "123!", extra: true });
  assert.deepEqual([...new Set(issues.map((issue) => issue.keyword))].sort(), ["additionalProperties", "enum", "pattern", "type"]);
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
  assert.throws(() => assertSupportedManifest(mutate((manifest) => { ((manifest.inputSchema as { properties: Record<string, unknown> }).properties.label as Record<string, unknown>).enum = []; })), /nonempty array/u);
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
