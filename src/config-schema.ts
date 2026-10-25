/** JSON Schema for yxu config files, for editor completion and validation (schema/yxu.schema.json). */
import { z } from "zod";
import { CONFIG_VERSION, ConfigSchema, SCHEMA_URL } from "./config.ts";

export function configJsonSchema(): Record<string, unknown> {
  // Any single layer may leave anything out (agents included), so every key is optional.
  const file = ConfigSchema.partial().extend({
    version: z.literal(CONFIG_VERSION).optional().describe("Config format version; `yxu config migrate` upgrades old files"),
  });
  const schema = z.toJSONSchema(file, { target: "draft-7", io: "input", unrepresentable: "any" }) as Record<string, unknown>;
  // `null` removes an agent or workflow defined by a lower layer.
  const props = schema.properties as Record<string, { additionalProperties?: unknown }>;
  // A layer may change one field of an agent defined below it (e.g. only `model`).
  delete (props.agents!.additionalProperties as { required?: string[] }).required;
  for (const key of ["agents", "workflows"]) {
    const entry = props[key]!;
    entry.additionalProperties = { anyOf: [entry.additionalProperties, { type: "null", description: "remove this entry from lower layers" }] };
  }
  return {
    $schema: "http://json-schema.org/draft-07/schema#",
    $id: SCHEMA_URL,
    title: "yxu configuration (yxu.yaml, yxu.local.yaml, ~/.config/yxu/config.yaml)",
    ...Object.fromEntries(Object.entries(schema).filter(([k]) => k !== "$schema")),
  };
}

export const schemaText = () => `${JSON.stringify(configJsonSchema(), null, 2)}\n`;
