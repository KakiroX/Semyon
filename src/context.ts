import type { z } from "zod";
import type { Db } from "./db.js";
import type { EventBus } from "./events.js";

export interface Config {
  /** Hide every tool that changes data (like a viewer-only permission in Atlassian/Notion). */
  readOnly: boolean;
  currency: string;
  /** Days without activity before a deal counts as stale. */
  staleDealDays: number;
  /** Flat sales tax rate applied to new orders unless overridden, e.g. 0.2 for 20%. */
  defaultTaxRate: number;
}

export interface Ctx {
  db: Db;
  events: EventBus;
  config: Config;
}

export interface ToolDef<S extends z.ZodRawShape = z.ZodRawShape> {
  name: string;
  title: string;
  description: string;
  input: S;
  /** True when the tool never changes data. Only read-only tools are exposed in read-only mode. */
  readOnly?: boolean;
  /** True when the tool removes or irreversibly overwrites data. */
  destructive?: boolean;
  handler: (args: z.infer<z.ZodObject<S>>) => unknown | Promise<unknown>;
}

/** Identity helper that keeps the handler's argument types tied to the input shape. */
export function defineTool<S extends z.ZodRawShape>(def: ToolDef<S>): ToolDef<S> {
  return def;
}
