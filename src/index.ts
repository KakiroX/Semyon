#!/usr/bin/env node
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createServer } from "./server.js";

const env = process.env;
const truthy = (v?: string) => /^(1|true|yes)$/i.test(v ?? "");

const dbPath = env.SEMYON_DB ?? join(homedir(), ".semyon", "semyon.db");
if (dbPath !== ":memory:") mkdirSync(dirname(dbPath), { recursive: true });

const { server, ctx } = createServer({
  dbPath,
  config: {
    readOnly: truthy(env.SEMYON_READ_ONLY),
    currency: env.SEMYON_CURRENCY ?? "USD",
    staleDealDays: env.SEMYON_STALE_DEAL_DAYS ? Number(env.SEMYON_STALE_DEAL_DAYS) : 7,
    defaultTaxRate: env.SEMYON_TAX_RATE ? Number(env.SEMYON_TAX_RATE) : 0,
  },
  events: { webhookTimeoutMs: env.SEMYON_WEBHOOK_TIMEOUT_MS ? Number(env.SEMYON_WEBHOOK_TIMEOUT_MS) : undefined },
});

await server.connect(new StdioServerTransport());
console.error(`semyon MCP server running (db: ${dbPath}${ctx.config.readOnly ? ", read-only" : ""})`);

const shutdown = () => {
  ctx.db.close();
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
