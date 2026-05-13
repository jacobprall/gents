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

  if (inner instanceof z.ZodString) {
    return attachDescription(schema, { type: "string" });
  }

  if (inner instanceof z.ZodNumber) {
    return attachDescription(schema, { type: "number" });
  }

  if (inner instanceof z.ZodBoolean) {
    return attachDescription(schema, { type: "boolean" });
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

  if (inner instanceof z.ZodObject) {
    const shape = inner.shape as Record<string, z.ZodTypeAny>;
    const properties: Record<string, unknown> = {};
    const required: string[] = [];

    for (const key of Object.keys(shape)) {
      const fieldSchema = shape[key]!;
      if (fieldSchema instanceof z.ZodOptional) {
        properties[key] = zodToJsonSchema(fieldSchema.unwrap());
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

  return attachDescription(schema, { type: "object", properties: {} });
}
