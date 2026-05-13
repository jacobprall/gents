import { z } from "zod";

function attachDescription(
  schema: z.ZodTypeAny,
  json: Record<string, unknown>,
): Record<string, unknown> {
  const d = schema.description;
  if (typeof d === "string" && d.length > 0) {
    return { ...json, description: d };
  }
  return json;
}

/**
 * Minimal Zod → JSON Schema conversion for Anthropic tool definitions.
 *
 * Throws on genuinely unsupported Zod types instead of silently emitting
 * an empty object (which would give the LLM a wrong schema).
 */
export function zodToJsonSchema(schema: z.ZodTypeAny): Record<string, unknown> {
  const unwrapEffects = (s: z.ZodTypeAny): z.ZodTypeAny => {
    if (s instanceof z.ZodEffects) {
      return unwrapEffects(s.innerType());
    }
    return s;
  };

  const inner = unwrapEffects(schema);

  if (inner instanceof z.ZodOptional) {
    return attachDescription(schema, zodToJsonSchema(inner.unwrap()));
  }

  if (inner instanceof z.ZodDefault) {
    const base = zodToJsonSchema(inner.removeDefault());
    return attachDescription(schema, { ...base, default: inner._def.defaultValue() });
  }

  if (inner instanceof z.ZodNullable) {
    const base = zodToJsonSchema(inner.unwrap());
    if (typeof base.type === "string") {
      return attachDescription(schema, { ...base, type: [base.type, "null"] });
    }
    return attachDescription(schema, { oneOf: [base, { type: "null" }] });
  }

  if (inner instanceof z.ZodString) {
    return attachDescription(schema, { type: "string" });
  }

  if (inner instanceof z.ZodNumber) {
    return attachDescription(schema, { type: "number" });
  }

  if (inner instanceof z.ZodBoolean) {
    return attachDescription(schema, { type: "boolean" });
  }

  if (inner instanceof z.ZodLiteral) {
    const val = inner.value;
    const type =
      typeof val === "string"
        ? "string"
        : typeof val === "number"
          ? "number"
          : typeof val === "boolean"
            ? "boolean"
            : "string";
    return attachDescription(schema, { type, const: val });
  }

  if (inner instanceof z.ZodEnum) {
    return attachDescription(schema, {
      type: "string",
      enum: [...inner.options],
    });
  }

  if (inner instanceof z.ZodArray) {
    const items = zodToJsonSchema(inner.element);
    return attachDescription(schema, { type: "array", items });
  }

  if (inner instanceof z.ZodRecord) {
    const valType = (inner._def as { valueType: z.ZodTypeAny }).valueType;
    return attachDescription(schema, {
      type: "object",
      additionalProperties: zodToJsonSchema(valType),
    });
  }

  if (inner instanceof z.ZodUnion) {
    const options = (inner._def.options as z.ZodTypeAny[]).map(zodToJsonSchema);
    return attachDescription(schema, { oneOf: options });
  }

  if (inner instanceof z.ZodObject) {
    const shape = inner.shape as Record<string, z.ZodTypeAny>;
    const properties: Record<string, unknown> = {};
    const required: string[] = [];

    for (const key of Object.keys(shape)) {
      const fieldSchema = shape[key]!;
      if (fieldSchema instanceof z.ZodOptional) {
        // Preserve any description on the ZodOptional wrapper itself.
        const converted = zodToJsonSchema(fieldSchema.unwrap());
        properties[key] = attachDescription(fieldSchema, converted);
      } else {
        required.push(key);
        properties[key] = zodToJsonSchema(fieldSchema);
      }
    }

    const obj: Record<string, unknown> = {
      type: "object",
      properties,
    };
    if (required.length > 0) {
      obj.required = required;
    }
    return attachDescription(schema, obj);
  }

  throw new Error(
    `zodToJsonSchema: unsupported Zod type "${inner.constructor.name}". ` +
      "Add a handler or simplify the schema.",
  );
}
