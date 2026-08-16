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
export const MAX_SCHEMA_NODES = 512;
export const MAX_SCHEMA_DEPTH = 32;
export const MAX_OBJECT_PROPERTIES = 128;
export const MAX_ENUM_VALUES = 256;
export const MAX_GENERATED_CASES = 2_048;
export const MAX_AGGREGATE_CASE_NODES = 1_000_000;
export const MAX_PATTERN_INPUT_LENGTH = 100_000;
export const MAX_JSON_VALUE_DEPTH = 64;
export const MAX_JSON_STRING_CODE_POINTS = 100_000;
export const MAX_JSON_VALUE_STRING_CODE_POINTS = 250_000;
export const MAX_AGGREGATE_LITERAL_NODES = 250_000;
export const MAX_AGGREGATE_LITERAL_STRING_CODE_POINTS = 1_000_000;

export interface JsonValueMeasurement {
  nodes: number;
  maxDepth: number;
  stringCodePoints: number;
}

function unicodeLength(value: string): number {
  let length = 0;
  for (const _character of value) length += 1;
  return length;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function isDenseArray(value: unknown): value is unknown[] {
  return Array.isArray(value)
    && Object.keys(value).length === value.length
    && Object.keys(value).every((key, index) => key === String(index));
}

function boundedAdd(left: number, right: number, limit: number): number {
  if (left > limit || right > limit || left > limit - right) return limit + 1;
  return left + right;
}

function boundedMultiply(left: number, right: number, limit: number): number {
  if (left === 0 || right === 0) return 0;
  if (left > limit || right > limit || left > Math.floor(limit / right)) return limit + 1;
  return left * right;
}

function boundedUnicodeLength(value: string, limit: number): number {
  let length = 0;
  for (const _character of value) {
    length += 1;
    if (length > limit) return limit + 1;
  }
  return length;
}

export function measureJsonValue(value: unknown, label = "JSON value"): JsonValueMeasurement {
  type Frame = { kind: "value"; value: unknown; depth: number } | { kind: "exit"; value: object };
  const stack: Frame[] = [{ kind: "value", value, depth: 1 }];
  const active = new Set<object>();
  let nodes = 0;
  let maxDepth = 0;
  let stringCodePoints = 0;

  const accountString = (text: string): void => {
    const length = boundedUnicodeLength(text, MAX_JSON_STRING_CODE_POINTS);
    if (length > MAX_JSON_STRING_CODE_POINTS) throw new Error(`${label} contains a string longer than ${MAX_JSON_STRING_CODE_POINTS} Unicode code points`);
    stringCodePoints = boundedAdd(stringCodePoints, length, MAX_JSON_VALUE_STRING_CODE_POINTS);
    if (stringCodePoints > MAX_JSON_VALUE_STRING_CODE_POINTS) throw new Error(`${label} exceeds aggregate string budget ${MAX_JSON_VALUE_STRING_CODE_POINTS} Unicode code points`);
  };

  while (stack.length > 0) {
    const frame = stack.pop();
    if (frame === undefined) break;
    if (frame.kind === "exit") {
      active.delete(frame.value);
      continue;
    }
    if (frame.depth > MAX_JSON_VALUE_DEPTH) throw new Error(`${label} exceeds maximum JSON value depth ${MAX_JSON_VALUE_DEPTH}`);
    maxDepth = Math.max(maxDepth, frame.depth);
    nodes = boundedAdd(nodes, 1, MAX_GENERATED_NODES);
    if (nodes > MAX_GENERATED_NODES) throw new Error(`${label} exceeds maximum JSON value node count ${MAX_GENERATED_NODES}`);

    const candidate = frame.value;
    if (candidate === null || typeof candidate === "boolean") continue;
    if (typeof candidate === "string") {
      accountString(candidate);
      continue;
    }
    if (typeof candidate === "number") {
      if (!Number.isFinite(candidate)) throw new Error(`${label} contains a non-finite number`);
      continue;
    }
    if (typeof candidate !== "object") throw new Error(`${label} contains a non-JSON ${typeof candidate} value`);
    if (active.has(candidate)) throw new Error(`${label} contains a cycle`);

    let children: unknown[];
    if (Array.isArray(candidate)) {
      const keys = Object.keys(candidate);
      if (keys.length !== candidate.length || keys.some((key, index) => key !== String(index))) throw new Error(`${label} contains a sparse or extended array`);
      if (candidate.length > MAX_GENERATED_NODES - nodes) throw new Error(`${label} exceeds maximum JSON value node count ${MAX_GENERATED_NODES}`);
      children = candidate;
    } else {
      if (!isRecord(candidate)) throw new Error(`${label} contains a non-plain object`);
      const keys = Object.keys(candidate);
      if (keys.length > MAX_GENERATED_NODES - nodes) throw new Error(`${label} exceeds maximum JSON value node count ${MAX_GENERATED_NODES}`);
      for (const key of keys) accountString(key);
      children = keys.map((key) => candidate[key]);
    }
    active.add(candidate);
    stack.push({ kind: "exit", value: candidate });
    for (let index = children.length - 1; index >= 0; index -= 1) {
      stack.push({ kind: "value", value: children[index], depth: frame.depth + 1 });
    }
  }
  return { nodes, maxDepth, stringCodePoints };
}

export function assertGeneratedWitness(value: unknown, label = "generated witness"): JsonValueMeasurement {
  return measureJsonValue(value, label);
}

function isJsonValue(value: unknown): boolean {
  try { measureJsonValue(value); return true; }
  catch { return false; }
}

function canonicalMeasured(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalMeasured).join(",")}]`;
  if (isRecord(value)) return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalMeasured(value[key])}`).join(",")}}`;
  return JSON.stringify(Object.is(value, -0) ? 0 : value);
}

function canonical(value: unknown): string {
  measureJsonValue(value);
  return canonicalMeasured(value);
}

export function schemaValueEqual(left: unknown, right: unknown): boolean {
  return canonical(left) === canonical(right);
}

function estimateNodeCases(schema: JsonSchema, depth = 0): number {
  if (depth > MAX_SCHEMA_DEPTH) return MAX_GENERATED_CASES + 1;
  let total = 1;
  if (schema.type !== undefined) total = boundedAdd(total, 1, MAX_GENERATED_CASES);
  for (const present of [
    Object.hasOwn(schema, "const"), schema.enum !== undefined, schema.minimum !== undefined, schema.maximum !== undefined,
    schema.minLength !== undefined, schema.maxLength !== undefined, schema.pattern !== undefined,
    schema.minItems !== undefined, schema.maxItems !== undefined,
  ]) if (present) total = boundedAdd(total, 1, MAX_GENERATED_CASES);
  if (schema.type === "object") {
    total = boundedAdd(total, (schema.required ?? []).length, MAX_GENERATED_CASES);
    total = boundedAdd(total, Number(schema.additionalProperties === false), MAX_GENERATED_CASES);
    for (const child of Object.values(schema.properties ?? {})) total = boundedAdd(total, estimateNodeCases(child, depth + 1), MAX_GENERATED_CASES);
  } else if (schema.type === "array" && schema.items !== undefined && (schema.maxItems ?? 1) > 0) {
    total = boundedAdd(total, estimateNodeCases(schema.items, depth + 1), MAX_GENERATED_CASES);
  }
  return total;
}

export function estimateGeneratedCaseCount(inputSchema: JsonSchema): number {
  let estimatedCases = boundedAdd(3, (inputSchema.required ?? []).length, MAX_GENERATED_CASES);
  estimatedCases = boundedAdd(estimatedCases, Number(inputSchema.additionalProperties === false), MAX_GENERATED_CASES);
  for (const child of Object.values(inputSchema.properties ?? {})) {
    estimatedCases = boundedAdd(estimatedCases, estimateNodeCases(child), MAX_GENERATED_CASES);
  }
  return estimatedCases;
}

export function assertAggregateGeneratedCaseBudget(caseCount: number, witnessNodes: number): void {
  if (boundedMultiply(caseCount, witnessNodes, MAX_AGGREGATE_CASE_NODES) > MAX_AGGREGATE_CASE_NODES) {
    throw new Error(`manifest exceeds maximum aggregate generated witness size ${MAX_AGGREGATE_CASE_NODES}`);
  }
}

type CharacterMatcher =
  | { kind: "literal"; value: string }
  | { kind: "any" }
  | { kind: "digit" | "word" | "space"; negated: boolean }
  | { kind: "class"; negated: boolean; members: ClassMember[] };
type ClassMember =
  | { kind: "literal"; value: string }
  | { kind: "range"; first: number; last: number }
  | { kind: "digit" | "word" | "space"; negated: boolean };
interface PatternToken { value: string; matcher: CharacterMatcher; minimum: number; maximum: number }
interface PatternProgram { tokens: PatternToken[]; minimumLength: number; maximumLength: number }

const ASCII_WITNESS = "a".repeat(MAX_GENERATED_CARDINALITY + 1);
const CLASS_WITNESS_CANDIDATES = [..."aA0zZ9_- !@#bcdefghijklmnopqrstuvwxyBCDEFGHIQRSTUVWXY12345678"];

function categoryMatches(kind: "digit" | "word" | "space", character: string): boolean {
  if (kind === "digit") return character >= "0" && character <= "9";
  if (kind === "word") return (character >= "A" && character <= "Z")
    || (character >= "a" && character <= "z")
    || (character >= "0" && character <= "9")
    || character === "_";
  return /\s/u.test(character);
}

function classMemberMatches(member: ClassMember, character: string): boolean {
  if (member.kind === "literal") return character === member.value;
  if (member.kind === "range") {
    const codePoint = character.codePointAt(0);
    return codePoint !== undefined && codePoint >= member.first && codePoint <= member.last;
  }
  const matched = categoryMatches(member.kind, character);
  return member.negated ? !matched : matched;
}

function characterMatches(matcher: CharacterMatcher, character: string): boolean {
  if (matcher.kind === "literal") return character === matcher.value;
  if (matcher.kind === "any") return !["\n", "\r", "\u2028", "\u2029"].includes(character);
  if (matcher.kind === "class") {
    const matched = matcher.members.some((member) => classMemberMatches(member, character));
    return matcher.negated ? !matched : matched;
  }
  const matched = categoryMatches(matcher.kind, character);
  return matcher.negated ? !matched : matched;
}

function escapedMatcher(escape: string, inClass: boolean): CharacterMatcher | undefined {
  if (["d", "D", "w", "W", "s", "S"].includes(escape)) {
    const lower = escape.toLowerCase() as "d" | "w" | "s";
    const kind = lower === "d" ? "digit" : lower === "w" ? "word" : "space";
    return { kind, negated: escape !== lower };
  }
  const controls: Record<string, string> = { n: "\n", r: "\r", t: "\t", f: "\f", v: "\v", "0": "\0" };
  if (Object.hasOwn(controls, escape)) return { kind: "literal", value: controls[escape] as string };
  if (inClass && escape === "b") return { kind: "literal", value: "\b" };
  const identityEscapes = inClass ? "/^$\\.*+?()[]{}|-" : "/^$\\.*+?()[]{}|";
  if (identityEscapes.includes(escape)) return { kind: "literal", value: escape };
  return undefined;
}

function classMemberFromMatcher(matcher: CharacterMatcher): ClassMember {
  if (matcher.kind === "literal") return matcher;
  if (matcher.kind === "digit" || matcher.kind === "word" || matcher.kind === "space") return matcher;
  throw new Error("pattern character class contains an unsupported nested matcher");
}

function parseCharacterClass(source: string, start: number): { matcher: CharacterMatcher; value: string; next: number } {
  let index = start + 1;
  let negated = false;
  if (source[index] === "^") { negated = true; index += 1; }
  const members: ClassMember[] = [];
  let closed = false;
  while (index < source.length) {
    if (source[index] === "]") { closed = true; index += 1; break; }
    let matcher: CharacterMatcher;
    let next: number;
    if (source[index] === "\\") {
      const escaped = source[index + 1];
      if (escaped === "0" && /[0-9]/u.test(source[index + 2] ?? "")) throw new Error("pattern contains an invalid decimal escape");
      const parsed = escaped === undefined ? undefined : escapedMatcher(escaped, true);
      if (parsed === undefined) throw new Error("pattern contains an unsupported character-class escape");
      matcher = parsed;
      next = index + 2;
    } else {
      const codePoint = source.codePointAt(index);
      if (codePoint === undefined) throw new Error("pattern contains an invalid character class");
      const value = String.fromCodePoint(codePoint);
      if (value === "[") throw new Error("pattern contains a nested character class");
      matcher = { kind: "literal", value };
      next = index + value.length;
    }
    const startsRange = source[next] === "-" && source[next + 1] !== "]" && next + 1 < source.length;
    if (startsRange && matcher.kind !== "literal") throw new Error("pattern range endpoints must be literal characters");
    if (matcher.kind === "literal" && startsRange) {
      const first = matcher.value.codePointAt(0) as number;
      const endIndex = next + 1;
      let lastValue: string;
      let rangeNext: number;
      if (source[endIndex] === "\\") {
        const escaped = source[endIndex + 1];
        if (escaped === "0" && /[0-9]/u.test(source[endIndex + 2] ?? "")) throw new Error("pattern contains an invalid decimal escape");
        const parsed = escaped === undefined ? undefined : escapedMatcher(escaped, true);
        if (parsed === undefined || parsed.kind !== "literal") throw new Error("pattern range endpoints must be literal characters");
        lastValue = parsed.value;
        rangeNext = endIndex + 2;
      } else {
        const codePoint = source.codePointAt(endIndex);
        if (codePoint === undefined) throw new Error("pattern contains an incomplete character-class range");
        lastValue = String.fromCodePoint(codePoint);
        if (lastValue === "[") throw new Error("pattern range endpoints must be literal characters");
        rangeNext = endIndex + lastValue.length;
      }
      const last = lastValue.codePointAt(0) as number;
      if (first > last) throw new Error("pattern contains a descending character-class range");
      members.push({ kind: "range", first, last });
      index = rangeNext;
    } else {
      members.push(classMemberFromMatcher(matcher));
      index = next;
    }
  }
  if (!closed || members.length === 0) throw new Error("pattern contains an invalid or empty character class");
  const compiled: CharacterMatcher = { kind: "class", negated, members };
  const value = CLASS_WITNESS_CANDIDATES.find((candidate) => characterMatches(compiled, candidate));
  if (value === undefined) throw new Error("pattern character class has no deterministic ASCII witness");
  return { matcher: compiled, value, next: index };
}

function compilePattern(pattern: string): PatternProgram {
  if (unicodeLength(pattern) > 256) throw new Error("pattern is longer than 256 Unicode code points");
  if (!pattern.startsWith("^") || !pattern.endsWith("$") || pattern.length < 2) {
    throw new Error("pattern must use explicit ^ and $ whole-string anchors");
  }
  const source = pattern.slice(1, -1);
  const tokens: PatternToken[] = [];
  let variableRepetitions = 0;
  for (let index = 0; index < source.length;) {
    const codePoint = source.codePointAt(index);
    if (codePoint === undefined) break;
    const character = String.fromCodePoint(codePoint);
    let tokenValue: string;
    let matcher: CharacterMatcher;
    if (["(", ")", "|", "^", "$"].includes(character)) throw new Error("pattern uses unsupported grouping, alternation, or anchors");
    if ("*+?{}".includes(character)) throw new Error("pattern contains a stray or stacked quantifier");
    if (character === "[") {
      const parsed = parseCharacterClass(source, index);
      tokenValue = parsed.value;
      matcher = parsed.matcher;
      index = parsed.next;
    } else if (character === "\\") {
      const escaped = source[index + 1];
      if (escaped === undefined) throw new Error("pattern ends with an incomplete escape");
      if (escaped === "0" && /[0-9]/u.test(source[index + 2] ?? "")) throw new Error("pattern contains an invalid decimal escape");
      const parsed = escapedMatcher(escaped, false);
      if (parsed === undefined) throw new Error(`pattern escape \\${escaped} is unsupported for deterministic generation`);
      matcher = parsed;
      tokenValue = CLASS_WITNESS_CANDIDATES.find((candidate) => characterMatches(matcher, candidate)) ?? " ";
      if (!characterMatches(matcher, tokenValue)) throw new Error(`pattern escape \\${escaped} has no deterministic ASCII witness`);
      index += 2;
    } else {
      tokenValue = character === "." ? "a" : character;
      matcher = character === "." ? { kind: "any" } : { kind: "literal", value: character };
      index += character.length;
    }
    let minimum = 1;
    let maximum = 1;
    const quantifier = source[index];
    if (quantifier === "+" || quantifier === "*" || quantifier === "?") {
      minimum = quantifier === "+" ? 1 : 0;
      maximum = quantifier === "?" ? 1 : MAX_GENERATED_CARDINALITY;
      variableRepetitions += 1;
      index += 1;
    } else if (quantifier === "{") {
      const match = /^\{(\d+)(?:,(\d*))?\}/u.exec(source.slice(index));
      if (match === null) throw new Error("pattern contains an invalid repetition");
      minimum = Number(match[1]);
      maximum = match[2] === undefined ? minimum : match[2] === "" ? MAX_GENERATED_CARDINALITY : Number(match[2]);
      if (!Number.isSafeInteger(minimum) || !Number.isSafeInteger(maximum) || minimum > maximum || maximum > MAX_GENERATED_CARDINALITY) throw new Error("pattern repetition is outside deterministic generation limits");
      if (minimum !== maximum) variableRepetitions += 1;
      index += match[0].length;
    }
    if (["*", "+", "?", "{"].includes(source[index] ?? "")) throw new Error("pattern contains a stacked quantifier");
    if (variableRepetitions > 1) throw new Error("pattern contains more than one variable repetition");
    tokens.push({ value: tokenValue, matcher, minimum, maximum });
  }
  const minimumLength = tokens.reduce((total, token) => boundedAdd(total, token.minimum, MAX_PATTERN_INPUT_LENGTH), 0);
  const maximumLength = tokens.reduce((total, token) => boundedAdd(total, token.maximum, MAX_PATTERN_INPUT_LENGTH), 0);
  if (minimumLength > MAX_PATTERN_INPUT_LENGTH || maximumLength > MAX_PATTERN_INPUT_LENGTH) {
    throw new Error(`pattern match length exceeds ${MAX_PATTERN_INPUT_LENGTH} Unicode code points`);
  }
  return { tokens, minimumLength, maximumLength };
}

function buildPatternValue(tokens: readonly PatternToken[], targetLength: number): string | undefined {
  const counts = tokens.map((token) => token.minimum);
  let length = counts.reduce((total, count, index) => total + count * unicodeLength(tokens[index]?.value ?? ""), 0);
  if (length > targetLength) return undefined;
  for (let index = tokens.length - 1; index >= 0 && length < targetLength; index -= 1) {
    const token = tokens[index];
    if (token === undefined || unicodeLength(token.value) === 0) continue;
    const tokenLength = unicodeLength(token.value);
    const room = token.maximum - (counts[index] ?? 0);
    const add = Math.min(room, Math.floor((targetLength - length) / tokenLength));
    counts[index] = (counts[index] ?? 0) + add;
    length += add * tokenLength;
  }
  if (length !== targetLength) return undefined;
  let value = "";
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    const count = counts[index] ?? 0;
    if (token === undefined || count < 0 || count > MAX_GENERATED_CARDINALITY) return undefined;
    for (let repetition = 0; repetition < count; repetition += 1) value += token.value;
  }
  return value;
}

function patternMatches(program: PatternProgram, value: string): boolean {
  const characters = [...value];
  if (characters.length < program.minimumLength || characters.length > program.maximumLength) return false;
  const variable = program.tokens.findIndex((token) => token.minimum !== token.maximum);
  const variableCount = variable === -1
    ? 0
    : characters.length - program.tokens.reduce((total, token, index) => total + (index === variable ? 0 : token.minimum), 0);
  if (variable !== -1) {
    const token = program.tokens[variable];
    if (token === undefined || variableCount < token.minimum || variableCount > token.maximum) return false;
  }
  let cursor = 0;
  for (let index = 0; index < program.tokens.length; index += 1) {
    const token = program.tokens[index];
    if (token === undefined) return false;
    const count = index === variable ? variableCount : token.minimum;
    for (let repetition = 0; repetition < count; repetition += 1) {
      const character = characters[cursor];
      if (character === undefined || !characterMatches(token.matcher, character)) return false;
      cursor += 1;
    }
  }
  return cursor === characters.length;
}

function boundedAsciiWitness(length: number, label: string): string {
  if (!Number.isSafeInteger(length) || length < 0 || length > MAX_GENERATED_CARDINALITY) {
    throw new Error(`${label} is outside deterministic generation limits`);
  }
  return ASCII_WITNESS.slice(0, length);
}

export function synthesizeString(schema: JsonSchema, edge: "minimum" | "maximum" = "minimum"): string {
  const minimum = schema.minLength ?? 0;
  const preferredMaximum = schema.maxLength ?? Math.max(minimum, 1);
  if (!Number.isSafeInteger(minimum) || minimum < 0 || minimum > MAX_GENERATED_CARDINALITY) throw new Error("minLength is outside deterministic generation limits");
  if (!Number.isSafeInteger(preferredMaximum) || preferredMaximum < minimum || preferredMaximum > MAX_GENERATED_CARDINALITY) throw new Error("maxLength is outside deterministic generation limits");
  if (schema.pattern === undefined) return boundedAsciiWitness(edge === "minimum" ? minimum : preferredMaximum, `${edge} string length`);
  const program = compilePattern(schema.pattern);
  const lower = Math.max(minimum, program.minimumLength);
  const upper = Math.min(schema.maxLength ?? MAX_GENERATED_CARDINALITY, program.maximumLength);
  if (lower > upper) throw new Error(`pattern ${schema.pattern} has no deterministic witness within its length bounds`);
  const length = edge === "maximum" ? Math.min(upper, Math.max(lower, preferredMaximum)) : lower;
  const value = buildPatternValue(program.tokens, length);
  if (value !== undefined && patternMatches(program, value)) return value;
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
  if (!isJsonValue(value)) {
    if (typeof value === "string" && schema.pattern !== undefined && unicodeLength(value) > MAX_PATTERN_INPUT_LENGTH) {
      return [{ path, keyword: "pattern", message: `value exceeds the ${MAX_PATTERN_INPUT_LENGTH}-code-point pattern evaluation limit` }];
    }
    return [{ path, keyword: "type", message: "expected a finite acyclic JSON value" }];
  }
  if (!typeMatches(schema.type, value)) {
    return [{ path, keyword: "type", message: `expected ${schema.type ?? "any"}, received ${Array.isArray(value) ? "array" : value === null ? "null" : typeof value}` }];
  }
  if (schema.const !== undefined && canonical(value) !== canonical(schema.const)) issues.push({ path, keyword: "const", message: "value does not match const" });
  if (schema.enum !== undefined) {
    const encodedValue = canonical(value);
    if (!schema.enum.some((entry) => canonical(entry) === encodedValue)) issues.push({ path, keyword: "enum", message: "value is not in enum" });
  }
  if (typeof value === "string") {
    const length = unicodeLength(value);
    if (schema.minLength !== undefined && length < schema.minLength) issues.push({ path, keyword: "minLength", message: `length ${length} is below ${schema.minLength}` });
    if (schema.maxLength !== undefined && length > schema.maxLength) issues.push({ path, keyword: "maxLength", message: `length ${length} exceeds ${schema.maxLength}` });
    if (schema.pattern !== undefined) {
      if (length > MAX_PATTERN_INPUT_LENGTH) {
        issues.push({ path, keyword: "pattern", message: `value exceeds the ${MAX_PATTERN_INPUT_LENGTH}-code-point pattern evaluation limit` });
      } else {
        try { if (!patternMatches(compilePattern(schema.pattern), value)) issues.push({ path, keyword: "pattern", message: `value does not match ${schema.pattern}` }); }
        catch { issues.push({ path, keyword: "pattern", message: "manifest contains an unsupported regex" }); }
      }
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
  let aggregateLiteralNodes = 0;
  let aggregateLiteralStringCodePoints = 0;
  const measureLiteral = (literal: unknown, path: string): JsonValueMeasurement => {
    const measurement = measureJsonValue(literal, path);
    aggregateLiteralNodes = boundedAdd(aggregateLiteralNodes, measurement.nodes, MAX_AGGREGATE_LITERAL_NODES);
    if (aggregateLiteralNodes > MAX_AGGREGATE_LITERAL_NODES) throw new Error(`manifest exceeds aggregate literal node budget ${MAX_AGGREGATE_LITERAL_NODES}`);
    aggregateLiteralStringCodePoints = boundedAdd(
      aggregateLiteralStringCodePoints,
      measurement.stringCodePoints,
      MAX_AGGREGATE_LITERAL_STRING_CODE_POINTS,
    );
    if (aggregateLiteralStringCodePoints > MAX_AGGREGATE_LITERAL_STRING_CODE_POINTS) {
      throw new Error(`manifest exceeds aggregate literal string budget ${MAX_AGGREGATE_LITERAL_STRING_CODE_POINTS} Unicode code points`);
    }
    return measurement;
  };
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
      if (!isDenseArray(schema.enum) || schema.enum.length === 0 || schema.enum.length > MAX_ENUM_VALUES) throw new Error(`${path}.enum must be a nonempty dense array of at most ${MAX_ENUM_VALUES} JSON values`);
      for (let index = 0; index < schema.enum.length; index += 1) measureLiteral(schema.enum[index], `${path}.enum[${index}]`);
      const encoded = schema.enum.map(canonicalMeasured);
      if (new Set(encoded).size !== encoded.length) throw new Error(`${path}.enum values must be unique`);
    }
    if (Object.hasOwn(schemaValue, "const")) measureLiteral(schema.const, `${path}.const`);
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
      if (typeof schema.pattern !== "string") throw new Error(`${path}.pattern must be a string`);
      try { compilePattern(schema.pattern); synthesizeString(schema); }
      catch (error: unknown) { throw new Error(`${path}.pattern is unsupported: ${error instanceof Error ? error.message : String(error)}`); }
    }
    if (schema.properties !== undefined && !isRecord(schema.properties)) throw new Error(`${path}.properties must be an object`);
    if (schema.properties !== undefined && Object.keys(schema.properties).length > MAX_OBJECT_PROPERTIES) throw new Error(`${path}.properties exceeds maximum property count ${MAX_OBJECT_PROPERTIES}`);
    if (schema.required !== undefined) {
      if (!isDenseArray(schema.required) || schema.required.some((entry) => typeof entry !== "string" || entry.length === 0) || new Set(schema.required).size !== schema.required.length) throw new Error(`${path}.required must contain a dense array of unique nonblank strings`);
      for (const key of schema.required) if (schema.properties === undefined || !Object.hasOwn(schema.properties, key)) throw new Error(`${path}.required references missing property ${key}`);
    }
    if (schema.additionalProperties !== undefined && typeof schema.additionalProperties !== "boolean") throw new Error(`${path}.additionalProperties must be boolean`);
    if (schema.items !== undefined) visit(schema.items, `${path}.items`, depth + 1);
    for (const [key, child] of Object.entries(schema.properties ?? {})) visit(child, `${path}.properties.${key}`, depth + 1);
    if (Object.hasOwn(schemaValue, "const")) {
      const relaxed = { ...schema };
      delete relaxed.const;
      if (validate(relaxed, schema.const).length > 0) throw new Error(`${path}.const contradicts the schema`);
    }
    if (schema.enum !== undefined) {
      const relaxed = { ...schema };
      delete relaxed.enum;
      if (!schema.enum.some((entry) => validate(relaxed, entry).length === 0)) throw new Error(`${path}.enum has no value satisfying the schema`);
    }
    seen.delete(schemaValue);
  };
  visit(manifest.inputSchema, "inputSchema");
  visit(manifest.outputSchema, "outputSchema");

  const estimateGeneratedNodes = (schema: JsonSchema, depth = 0): number => {
    if (depth > MAX_SCHEMA_DEPTH) return MAX_GENERATED_NODES + 1;
    if (Object.hasOwn(schema, "const")) return measureJsonValue(schema.const, "const witness").nodes;
    if (schema.enum !== undefined) {
      return schema.enum.reduce<number>((maximum, entry) => Math.max(maximum, measureJsonValue(entry, "enum witness").nodes), 0);
    }
    if (schema.type === "array") {
      const length = schema.maxItems ?? Math.max(1, schema.minItems ?? 0);
      const itemCost = schema.items === undefined ? 1 : estimateGeneratedNodes(schema.items, depth + 1);
      return boundedAdd(1, boundedMultiply(length, itemCost, MAX_GENERATED_NODES), MAX_GENERATED_NODES);
    }
    if (schema.type === "object") {
      return Object.values(schema.properties ?? {}).reduce(
        (total, child) => boundedAdd(total, estimateGeneratedNodes(child, depth + 1), MAX_GENERATED_NODES),
        1,
      );
    }
    return 1;
  };
  for (const [label, schema] of [["inputSchema", manifest.inputSchema], ["outputSchema", manifest.outputSchema]] as const) {
    if (estimateGeneratedNodes(schema) > MAX_GENERATED_NODES) throw new Error(`${label} exceeds maximum deterministic witness size ${MAX_GENERATED_NODES}`);
  }

  const inputSchema = manifest.inputSchema as JsonSchema;
  const estimatedCases = estimateGeneratedCaseCount(inputSchema);
  if (estimatedCases > MAX_GENERATED_CASES) throw new Error(`manifest exceeds maximum generated case count ${MAX_GENERATED_CASES}`);
  const inputWitnessNodes = estimateGeneratedNodes(inputSchema);
  assertAggregateGeneratedCaseBudget(estimatedCases, inputWitnessNodes);
}
