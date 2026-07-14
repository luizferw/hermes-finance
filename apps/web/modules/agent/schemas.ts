import { z, type ZodType } from "zod";

/**
 * One zod schema per tool → both a Gemini function-declaration parameter schema
 * and (directly) the MCP inputSchema. Generating both from the same source is
 * the point of the canonical registry: declarations never drift from validation.
 */
export function toJsonSchema(schema: ZodType): Record<string, unknown> {
  const json = z.toJSONSchema(schema, {
    target: "draft-7",
    io: "input",
    unrepresentable: "any",
  }) as Record<string, unknown>;
  delete json.$schema;
  return json;
}
