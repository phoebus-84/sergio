// ---------------------------------------------------------------------------
// A small JSON Schema reader for the browser
// ---------------------------------------------------------------------------
// The film manifests and the cut timeline are edited in the studio as forms,
// so the browser must check them as the agent's tools and the gateway do, with
// the same schema. ajv is what the other contracts use, and it is a Node
// dependency this package should not bundle into a page. This reads the part
// of draft 2020-12 those two schemas are written in — and refuses, loudly, a
// keyword it does not know, so a schema that grows past it fails its tests
// here instead of silently accepting everything.
//
// The fixture checks run every film and cut fixture through ajv as well, so
// the two readings cannot drift apart unnoticed.
// ---------------------------------------------------------------------------

const KNOWN = new Set([
  "$schema", "$id", "$defs", "$ref", "title", "description", "type", "const", "enum",
  "required", "properties", "additionalProperties", "items", "minItems", "maxItems", "uniqueItems",
  "minLength", "maxLength", "pattern", "minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum",
  "multipleOf", "format", "oneOf", "anyOf", "default", "examples", "propertyNames",
]);

const typeOf = (value) => {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  if (typeof value === "number") return Number.isInteger(value) ? "integer" : "number";
  return typeof value;
};

const isType = (value, type) => {
  const actual = typeOf(value);
  return actual === type || (type === "number" && actual === "integer");
};

const DATE_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;

/**
 * Problems of `value` under `schema`, as `{code, path, message}`; none when it holds.
 *
 * @param {object} root the schema document `$ref`s resolve in (`#/$defs/<name>` only)
 * @param {object} schema the schema to hold `value` to
 * @param {unknown} value
 * @param {string} [path] the JSON path of `value`, for the problems
 */
export function check(root, schema, value, path = "$") {
  const out = [];
  walk(root, schema, value, path, out);
  return out;
}

function walk(root, schema, value, path, out) {
  if (schema === true) return;
  for (const key of Object.keys(schema)) {
    if (!KNOWN.has(key)) throw new Error(`schema-lite does not read "${key}" (at ${path})`);
  }
  if (schema.$ref !== undefined) {
    const match = /^#\/\$defs\/([A-Za-z0-9_]+)$/.exec(schema.$ref);
    if (!match || !root.$defs?.[match[1]]) throw new Error(`schema-lite cannot resolve ${schema.$ref}`);
    walk(root, root.$defs[match[1]], value, path, out);
  }
  const add = (code, message) => out.push({ code, path, message });

  if (schema.const !== undefined && value !== schema.const) add("const", `must be ${JSON.stringify(schema.const)}`);
  if (schema.enum && !schema.enum.includes(value)) add("enum", `must be one of ${schema.enum.join(", ")}`);
  if (schema.type) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    if (!types.some((type) => isType(value, type))) {
      add("type", `must be ${types.join(" or ")}`);
      return;
    }
  }
  for (const key of ["oneOf", "anyOf"]) {
    if (!schema[key]) continue;
    const passing = schema[key].filter((option) => check(root, option, value, path).length === 0).length;
    if (key === "anyOf" ? passing === 0 : passing !== 1) add(key, `must match ${key === "anyOf" ? "one" : "exactly one"} of its ${schema[key].length} forms`);
  }

  if (typeof value === "string") {
    if (schema.minLength !== undefined && value.length < schema.minLength) add("minLength", `must have at least ${schema.minLength} character(s)`);
    if (schema.maxLength !== undefined && value.length > schema.maxLength) add("maxLength", `must have at most ${schema.maxLength} characters`);
    if (schema.pattern !== undefined && !new RegExp(schema.pattern, "u").test(value)) add("pattern", `must match ${schema.pattern}`);
    if (schema.format === "date-time" && !DATE_TIME.test(value)) add("format", "must be a date and time (ISO 8601)");
  }
  if (typeof value === "number") {
    if (schema.minimum !== undefined && value < schema.minimum) add("minimum", `must be at least ${schema.minimum}`);
    if (schema.maximum !== undefined && value > schema.maximum) add("maximum", `must be at most ${schema.maximum}`);
    if (schema.exclusiveMinimum !== undefined && value <= schema.exclusiveMinimum) add("exclusiveMinimum", `must be more than ${schema.exclusiveMinimum}`);
    if (schema.exclusiveMaximum !== undefined && value >= schema.exclusiveMaximum) add("exclusiveMaximum", `must be less than ${schema.exclusiveMaximum}`);
    if (schema.multipleOf !== undefined && Math.abs(value / schema.multipleOf - Math.round(value / schema.multipleOf)) > 1e-9) add("multipleOf", `must be a multiple of ${schema.multipleOf}`);
  }
  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems) add("minItems", `must have at least ${schema.minItems} item(s)`);
    if (schema.maxItems !== undefined && value.length > schema.maxItems) add("maxItems", `must have at most ${schema.maxItems} items`);
    if (schema.uniqueItems) {
      const seen = new Set();
      for (const item of value) {
        const key = JSON.stringify(item);
        if (seen.has(key)) add("uniqueItems", `names ${key} twice`);
        seen.add(key);
      }
    }
    if (schema.items) value.forEach((item, index) => walk(root, schema.items, item, `${path}[${index}]`, out));
  }
  if (typeOf(value) === "object") {
    for (const key of schema.required ?? []) {
      if (value[key] === undefined) out.push({ code: "required", path: `${path}.${key}`, message: "is required" });
    }
    const properties = schema.properties ?? {};
    for (const [key, item] of Object.entries(value)) {
      if (item === undefined) continue;
      if (schema.propertyNames) walk(root, schema.propertyNames, key, `${path}.${key}`, out);
      if (properties[key] !== undefined) walk(root, properties[key], item, `${path}.${key}`, out);
      else if (schema.additionalProperties === false) out.push({ code: "additionalProperties", path: `${path}.${key}`, message: "is not a known field" });
      else if (schema.additionalProperties && typeof schema.additionalProperties === "object") walk(root, schema.additionalProperties, item, `${path}.${key}`, out);
    }
  }
}
