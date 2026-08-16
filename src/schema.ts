export const MANIFEST_VERSION = "tooldrill.manifest/v1" as const;

export interface JsonSchema {
  type?: "object" | "array" | "string" | "number" | "integer" | "boolean" | "null";
  title?: string;
  description?: string;
  enum?: unknown[];
  const?: unknown;
  properties?: Record<string, JsonSchema>;
  required?: string[];
  additionalProperties?: boolean;
  items?: JsonSchema;
  minItems?: number;
  maxItems?: number;
  minLength?: number;
  maxLength?: number;
  pattern?: string;
  minimum?: number;
  maximum?: number;
}

export interface ToolManifest {
  version: typeof MANIFEST_VERSION;
  name: string;
  description: string;
  inputSchema: JsonSchema;
  outputSchema: JsonSchema;
}

export interface ValidationIssue {
  path: string;
  keyword: string;
  message: string;
}

const TYPES = new Set<unknown>(["object", "array", "string", "number", "integer", "boolean", "null"]);
const SCHEMA_KEYS = new Set(["type", "title", "description", "enum", "const", "properties", "required", "additionalProperties", "items", "minItems", "maxItems", "minLength", "maxLength", "pattern", "minimum", "maximum"]);
export const MAX_GENERATED_CARDINALITY = 10_000;
export const MAX_GENERATED_NODES = 50_000;
export const MAX_SCHEMA_NODES = 2_000;
export const MAX_SCHEMA_DEPTH = 32;

function isRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function isJsonValue(value: unknown, seen = new Set<object>()): boolean {
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) {
    if (Object.keys(value).length !== value.length || Object.keys(value).some((key, index) => key !== String(index))) return false;
    if (seen.has(value)) return false;
    seen.add(value);
    const valid = value.every((entry) => isJsonValue(entry, seen));
    seen.delete(value);
    return valid;
  }
  if (isRecord(value)) {
    if (seen.has(value)) return false;
    seen.add(value);
    const valid = Object.values(value).every((entry) => isJsonValue(entry, seen));
    seen.delete(value);
    return valid;
  }
  return false;
}

function canonical(value: unknown): string {
  if (!isJsonValue(value)) throw new TypeError("value is not finite acyclic JSON");
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (isRecord(value)) return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
  return JSON.stringify(Object.is(value, -0) ? 0 : value);
}

export function schemaValueEqual(left: unknown, right: unknown): boolean {
  return canonical(left) === canonical(right);
}

interface PatternToken { value: string; minimum: number; maximum: number }

function classValue(source: string): string {
  let expression: RegExp;
  try { expression = new RegExp(`^[${source}]$`, "u"); }
  catch { throw new Error("pattern contains an invalid character class"); }
  const candidates = "aA0zZ9_- !@#bcdefghijklmnopqrstuvwxyBCDEFGHIQRSTUVWXY12345678";
  for (const candidate of candidates) if (expression.test(candidate)) return candidate;
  throw new Error("pattern character class has no deterministic ASCII witness");
}

function parsePattern(pattern: string): PatternToken[] {
  let source = pattern;
  if (source.startsWith("^")) source = source.slice(1);
  if (source.endsWith("$") && !source.endsWith("\\$")) source = source.slice(0, -1);
  const tokens: PatternToken[] = [];
  for (let index = 0; index < source.length;) {
    const character = source[index];
    if (character === undefined) break;
    let tokenValue: string;
    if (["(", ")", "|", "^", "$"].includes(character)) throw new Error("pattern uses unsupported grouping, alternation, or anchors");
    if (character === "[") {
      let end = index + 1;
      for (; end < source.length; end += 1) if (source[end] === "]" && source[end - 1] !== "\\") break;
      if (end >= source.length) throw new Error("pattern contains an unterminated character class");
      tokenValue = classValue(source.slice(index + 1, end));
      index = end + 1;
    } else if (character === "\\") {
      const escaped = source[index + 1];
      if (escaped === undefined) throw new Error("pattern ends with an incomplete escape");
      if (escaped === "d") tokenValue = "0";
      else if (escaped === "w") tokenValue = "a";
      else if (escaped === "s") tokenValue = " ";
      else if ([".", "-", "_", "/", "\\", "+", "*", "?", "!", ":"].includes(escaped)) tokenValue = escaped;
      else throw new Error(`pattern escape \\${escaped} is unsupported for deterministic generation`);
      index += 2;
    } else {
      tokenValue = character === "." ? "a" : character;
      index += 1;
    }
    let minimum = 1;
    let maximum = 1;
    const quantifier = source[index];
    if (quantifier === "+" || quantifier === "*" || quantifier === "?") {
      minimum = quantifier === "+" ? 1 : 0;
      maximum = quantifier === "?" ? 1 : MAX_GENERATED_CARDINALITY;
      index += 1;
    } else if (quantifier === "{") {
      const match = /^\{(\d+)(?:,(\d*))?\}/u.exec(source.slice(index));
      if (match === null) throw new Error("pattern contains an invalid repetition");
      minimum = Number(match[1]);
      maximum = match[2] === undefined ? minimum : match[2] === "" ? MAX_GENERATED_CARDINALITY : Number(match[2]);
      if (!Number.isSafeInteger(minimum) || !Number.isSafeInteger(maximum) || minimum > maximum || maximum > MAX_GENERATED_CARDINALITY) throw new Error("pattern repetition is outside deterministic generation limits");
      index += match[0].length;
    }
    tokens.push({ value: tokenValue, minimum, maximum });
  }
  return tokens;
}

function buildPatternValue(tokens: readonly PatternToken[], targetLength: number): string | undefined {
  const counts = tokens.map((token) => token.minimum);
  let length = counts.reduce((total, count, index) => total + count * (tokens[index]?.value.length ?? 0), 0);
  if (length > targetLength) return undefined;
  for (let index = tokens.length - 1; index >= 0 && length < targetLength; index -= 1) {
    const token = tokens[index];
    if (token === undefined || token.value.length === 0) continue;
    const room = token.maximum - (counts[index] ?? 0);
    const add = Math.min(room, Math.floor((targetLength - length) / token.value.length));
    counts[index] = (counts[index] ?? 0) + add;
    length += add * token.value.length;
  }
  if (length !== targetLength) return undefined;
  return tokens.map((token, index) => token.value.repeat(counts[index] ?? 0)).join("");
}

export function synthesizeString(schema: JsonSchema, edge: "minimum" | "maximum" = "minimum"): string {
  const minimum = schema.minLength ?? 0;
  const maximum = schema.maxLength ?? Math.max(minimum, 1);
  if (schema.pattern === undefined) return "a".repeat(edge === "minimum" ? minimum : maximum);
  const expression = new RegExp(schema.pattern, "u");
  const tokens = parsePattern(schema.pattern);
  const tokenMinimum = tokens.reduce((total, token) => total + token.value.length * token.minimum, 0);
  const lower = Math.max(minimum, tokenMinimum);
  const preferred = edge === "maximum" ? maximum : lower;
  for (let length = preferred; length >= lower; length -= 1) {
    const value = buildPatternValue(tokens, length);
    if (value !== undefined && expression.test(value)) return value;
  }
  throw new Error(`pattern ${schema.pattern} has no deterministic witness within its length bounds`);
}

function typeMatches(type: JsonSchema["type"], value: unknown): boolean {
  switch (type) {
    case undefined: return true;
    case "null": return value === null;
    case "array": return Array.isArray(value);
    case "object": return value !== null && typeof value === "object" && !Array.isArray(value);
    case "number": return typeof value === "number" && Number.isFinite(value);
    case "integer": return typeof value === "number" && Number.isFinite(value) && Number.isInteger(value);
    default: return typeof value === type;
  }
}

export function validate(schema: JsonSchema, value: unknown, path = "$" ): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  if (typeof value === "number" && !Number.isFinite(value)) {
    return [{ path, keyword: "type", message: "expected a finite JSON number" }];
  }
  if (!isJsonValue(value)) return [{ path, keyword: "type", message: "expected a finite acyclic JSON value" }];
  if (!typeMatches(schema.type, value)) {
    return [{ path, keyword: "type", message: `expected ${schema.type ?? "any"}, received ${Array.isArray(value) ? "array" : value === null ? "null" : typeof value}` }];
  }
  if (schema.const !== undefined && canonical(value) !== canonical(schema.const)) issues.push({ path, keyword: "const", message: "value does not match const" });
  if (schema.enum !== undefined && !schema.enum.some((entry) => canonical(entry) === canonical(value))) issues.push({ path, keyword: "enum", message: "value is not in enum" });
  if (typeof value === "string") {
    if (schema.minLength !== undefined && value.length < schema.minLength) issues.push({ path, keyword: "minLength", message: `length ${value.length} is below ${schema.minLength}` });
    if (schema.maxLength !== undefined && value.length > schema.maxLength) issues.push({ path, keyword: "maxLength", message: `length ${value.length} exceeds ${schema.maxLength}` });
    if (schema.pattern !== undefined) {
      try { if (!new RegExp(schema.pattern, "u").test(value)) issues.push({ path, keyword: "pattern", message: `value does not match ${schema.pattern}` }); }
      catch { issues.push({ path, keyword: "pattern", message: "manifest contains an invalid regex" }); }
    }
  }
  if (typeof value === "number") {
    if (schema.minimum !== undefined && value < schema.minimum) issues.push({ path, keyword: "minimum", message: `${value} is below ${schema.minimum}` });
    if (schema.maximum !== undefined && value > schema.maximum) issues.push({ path, keyword: "maximum", message: `${value} exceeds ${schema.maximum}` });
  }
  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems) issues.push({ path, keyword: "minItems", message: `item count ${value.length} is below ${schema.minItems}` });
    if (schema.maxItems !== undefined && value.length > schema.maxItems) issues.push({ path, keyword: "maxItems", message: `item count ${value.length} exceeds ${schema.maxItems}` });
    if (schema.items !== undefined) value.forEach((entry, index) => issues.push(...validate(schema.items as JsonSchema, entry, `${path}[${index}]`)));
  }
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    const record = value as Record<string, unknown>;
    for (const required of schema.required ?? []) if (!Object.hasOwn(record, required)) issues.push({ path: `${path}.${required}`, keyword: "required", message: "required property is missing" });
    for (const key of Object.keys(record).sort()) {
      const childSchema = schema.properties !== undefined && Object.hasOwn(schema.properties, key) ? schema.properties[key] : undefined;
      if (childSchema !== undefined) issues.push(...validate(childSchema, record[key], `${path}.${key}`));
      else if (schema.additionalProperties === false) issues.push({ path: `${path}.${key}`, keyword: "additionalProperties", message: "unexpected property" });
    }
  }
  return issues;
}

export function assertSupportedManifest(manifest: ToolManifest): void {
  if (!isRecord(manifest)) throw new Error("manifest must be an object");
  const manifestKeys = Object.keys(manifest);
  const expectedManifestKeys = ["version", "name", "description", "inputSchema", "outputSchema"];
  if (manifestKeys.some((key) => !expectedManifestKeys.includes(key)) || expectedManifestKeys.some((key) => !Object.hasOwn(manifest, key))) throw new Error("manifest schema is invalid or contains unsupported fields");
  if (manifest.version !== MANIFEST_VERSION) throw new Error(`unsupported manifest version: ${String(manifest.version)}`);
  if (typeof manifest.name !== "string" || manifest.name.trim().length === 0) throw new Error("manifest name must be a nonblank string");
  if (typeof manifest.description !== "string" || manifest.description.trim().length === 0) throw new Error("manifest description must be a nonblank string");
  if (!isRecord(manifest.inputSchema) || manifest.inputSchema.type !== "object") throw new Error("v1 inputSchema must be an object schema");
  if (!isRecord(manifest.outputSchema) || manifest.outputSchema.type === undefined) throw new Error("v1 outputSchema must declare a type");

  const seen = new Set<object>();
  let schemaNodes = 0;
  const visit = (schemaValue: unknown, path: string, depth = 0): void => {
    if (!isRecord(schemaValue)) throw new Error(`${path} must be a schema object`);
    if (depth > MAX_SCHEMA_DEPTH) throw new Error(`${path} exceeds maximum schema depth ${MAX_SCHEMA_DEPTH}`);
    schemaNodes += 1;
    if (schemaNodes > MAX_SCHEMA_NODES) throw new Error(`manifest exceeds maximum schema node count ${MAX_SCHEMA_NODES}`);
    if (seen.has(schemaValue)) throw new Error(`${path} contains a cyclic schema`);
    seen.add(schemaValue);
    const schema = schemaValue as JsonSchema;
    const unsupported = Object.keys(schemaValue).find((key) => !SCHEMA_KEYS.has(key));
    if (unsupported !== undefined) throw new Error(`${path}.${unsupported} is unsupported`);
    if (schema.type !== undefined && !TYPES.has(schema.type)) throw new Error(`${path}.type is unsupported`);
    for (const key of ["title", "description"] as const) if (schema[key] !== undefined && typeof schema[key] !== "string") throw new Error(`${path}.${key} must be a string`);
    if (schema.enum !== undefined) {
      if (!Array.isArray(schema.enum) || schema.enum.length === 0 || schema.enum.some((entry) => !isJsonValue(entry))) throw new Error(`${path}.enum must be a nonempty array of JSON values`);
      const encoded = schema.enum.map(canonical);
      if (new Set(encoded).size !== encoded.length) throw new Error(`${path}.enum values must be unique`);
    }
    if (Object.hasOwn(schemaValue, "const") && !isJsonValue(schema.const)) throw new Error(`${path}.const must be a JSON value`);
    for (const keyword of ["minimum", "maximum"] as const) {
      const value = schema[keyword];
      if (value !== undefined && (!Number.isFinite(value) || Math.abs(value) > Number.MAX_SAFE_INTEGER)) throw new Error(`${path}.${keyword} must be finite and within the safe deterministic generation range`);
    }
    for (const keyword of ["minItems", "maxItems", "minLength", "maxLength"] as const) {
      const value = schema[keyword];
      if (value !== undefined && (!Number.isSafeInteger(value) || value < 0 || value > MAX_GENERATED_CARDINALITY)) throw new Error(`${path}.${keyword} must be a nonnegative safe integer no greater than ${MAX_GENERATED_CARDINALITY}`);
    }
    if (schema.minimum !== undefined && schema.maximum !== undefined && schema.minimum > schema.maximum) throw new Error(`${path} has contradictory numeric bounds`);
    if (schema.type === "integer" && Math.ceil(schema.minimum ?? Number.MIN_SAFE_INTEGER) > Math.floor(schema.maximum ?? Number.MAX_SAFE_INTEGER)) throw new Error(`${path} has no integer within its numeric bounds`);
    if (schema.minItems !== undefined && schema.maxItems !== undefined && schema.minItems > schema.maxItems) throw new Error(`${path} has contradictory array bounds`);
    if (schema.minLength !== undefined && schema.maxLength !== undefined && schema.minLength > schema.maxLength) throw new Error(`${path} has contradictory string bounds`);
    if ((schema.minimum !== undefined || schema.maximum !== undefined) && schema.type !== "number" && schema.type !== "integer") throw new Error(`${path} numeric bounds require number or integer type`);
    if ((schema.minItems !== undefined || schema.maxItems !== undefined || schema.items !== undefined) && schema.type !== "array") throw new Error(`${path} array keywords require array type`);
    if ((schema.minLength !== undefined || schema.maxLength !== undefined || schema.pattern !== undefined) && schema.type !== "string") throw new Error(`${path} string keywords require string type`);
    if ((schema.properties !== undefined || schema.required !== undefined || schema.additionalProperties !== undefined) && schema.type !== "object") throw new Error(`${path} object keywords require object type`);
    if (schema.pattern !== undefined) {
      if (typeof schema.pattern !== "string" || schema.pattern.length > 256) throw new Error(`${path}.pattern must be a string no longer than 256 characters`);
      try { new RegExp(schema.pattern, "u"); synthesizeString(schema); }
      catch (error: unknown) { throw new Error(`${path}.pattern is unsupported: ${error instanceof Error ? error.message : String(error)}`); }
    }
    if (schema.properties !== undefined && !isRecord(schema.properties)) throw new Error(`${path}.properties must be an object`);
    if (schema.required !== undefined) {
      if (!Array.isArray(schema.required) || schema.required.some((entry) => typeof entry !== "string" || entry.length === 0) || new Set(schema.required).size !== schema.required.length) throw new Error(`${path}.required must contain unique nonblank strings`);
      for (const key of schema.required) if (schema.properties === undefined || !Object.hasOwn(schema.properties, key)) throw new Error(`${path}.required references missing property ${key}`);
    }
    if (schema.additionalProperties !== undefined && typeof schema.additionalProperties !== "boolean") throw new Error(`${path}.additionalProperties must be boolean`);
    if (schema.items !== undefined) visit(schema.items, `${path}.items`, depth + 1);
    for (const [key, child] of Object.entries(schema.properties ?? {})) visit(child, `${path}.properties.${key}`, depth + 1);
    if (Object.hasOwn(schemaValue, "const") && validate(schema, schema.const).length > 0) throw new Error(`${path}.const contradicts the schema`);
    if (schema.enum !== undefined && !schema.enum.some((entry) => validate(schema, entry).length === 0)) throw new Error(`${path}.enum has no value satisfying the schema`);
    seen.delete(schemaValue);
  };
  visit(manifest.inputSchema, "inputSchema");
  visit(manifest.outputSchema, "outputSchema");

  const estimateGeneratedNodes = (schema: JsonSchema, depth = 0): number => {
    if (depth > MAX_SCHEMA_DEPTH) return MAX_GENERATED_NODES + 1;
    if (schema.type === "array") {
      const length = schema.maxItems ?? Math.max(1, schema.minItems ?? 0);
      const itemCost = schema.items === undefined ? 1 : estimateGeneratedNodes(schema.items, depth + 1);
      return 1 + length * itemCost;
    }
    if (schema.type === "object") return 1 + Object.values(schema.properties ?? {}).reduce((total, child) => total + estimateGeneratedNodes(child, depth + 1), 0);
    return 1;
  };
  for (const [label, schema] of [["inputSchema", manifest.inputSchema], ["outputSchema", manifest.outputSchema]] as const) {
    if (estimateGeneratedNodes(schema) > MAX_GENERATED_NODES) throw new Error(`${label} exceeds maximum deterministic witness size ${MAX_GENERATED_NODES}`);
  }
}
