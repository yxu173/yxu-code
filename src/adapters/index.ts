import type { Adapter, CliName } from "../types.ts";
import { claude } from "./claude.ts";
import { commandcode } from "./commandcode.ts";
import { opencode } from "./opencode.ts";

export const adapters: Record<CliName, Adapter> = { commandcode, opencode, claude };
