/** JSON Schema for yxu config files, for editor completion and validation (schema/yxu.schema.json). */
import { ManifestSchema } from "./packs.ts";
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

export const PACK_SCHEMA_URL = "https://raw.githubusercontent.com/yxu173/yxu-code/main/schema/yxu-pack.schema.json";

/** JSON Schema for a pack's yxu-pack.yaml: the manifest fields, with `config` as a config file. */
export function packJsonSchema(): Record<string, unknown> {
  const manifest = z.toJSONSchema(ManifestSchema, { target: "draft-7", io: "input", unrepresentable: "any" }) as Record<string, unknown>;
  const config = configJsonSchema();
  const configProps = { ...(config.properties as Record<string, unknown>) };
  delete configProps.version;
  delete configProps.extends;
  const props = manifest.properties as Record<string, unknown>;
  props.config = { type: "object", description: (props.config as { description?: string }).description, properties: configProps, additionalProperties: false };
  return {
    $schema: "http://json-schema.org/draft-07/schema#",
    $id: PACK_SCHEMA_URL,
    title: "yxu pack manifest (yxu-pack.yaml)",
    ...Object.fromEntries(Object.entries(manifest).filter(([k]) => k !== "$schema")),
    // Recursive parts of the config (workflow steps) live here.
    ...(config.definitions ? { definitions: config.definitions } : {}),
  };
}

export const packSchemaText = () => `${JSON.stringify(packJsonSchema(), null, 2)}\n`;
