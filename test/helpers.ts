import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer, type ServerOptions } from "../src/server.js";

export interface Harness {
  client: Client;
  ctx: ReturnType<typeof createServer>["ctx"];
  /** Calls a tool and returns parsed JSON; throws on tool errors. */
  call: (name: string, args?: Record<string, unknown>) => Promise<any>;
  /** Calls a tool expecting an error; returns the error text. */
  fail: (name: string, args?: Record<string, unknown>) => Promise<string>;
  close: () => Promise<void>;
}

export async function harness(opts: ServerOptions = {}): Promise<Harness> {
  const { server, ctx } = createServer(opts);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "0.0.0" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

  const raw = async (name: string, args: Record<string, unknown> = {}) => {
    const res = (await client.callTool({ name, arguments: args })) as { content: { type: string; text: string }[]; isError?: boolean };
    return { text: res.content[0].text, isError: !!res.isError };
  };

  return {
    client,
    ctx,
    call: async (name, args) => {
      const r = await raw(name, args);
      if (r.isError) throw new Error(`${name} failed: ${r.text}`);
      return JSON.parse(r.text);
    },
    fail: async (name, args) => {
      const r = await raw(name, args);
      if (!r.isError) throw new Error(`${name} unexpectedly succeeded: ${r.text}`);
      return r.text;
    },
    close: async () => {
      await client.close();
      ctx.db.close();
    },
  };
}

/** A tiny shop: one supplier, two products, one customer. */
export async function seedBasics(h: Harness) {
  await h.call("supplier_upsert", { name: "Shenzhen Parts Co", email: "sales@szparts.example", lead_time_days: 10 });
  await h.call("product_upsert", {
    sku: "ESP32-DEV",
    name: "ESP32 Dev Board",
    category: "Microcontrollers",
    price: 12.5,
    cost: 4,
    initial_stock: 20,
    reorder_point: 5,
    reorder_qty: 50,
    supplier: "Shenzhen Parts Co",
    specs: { wifi: "802.11 b/g/n", bluetooth: "4.2", flash_mb: 4 },
  });
  await h.call("product_upsert", {
    sku: "USB-C-1M",
    name: "USB-C Cable 1m",
    category: "Cables",
    price: 6,
    cost: 1.5,
    initial_stock: 100,
    reorder_point: 20,
    supplier: "Shenzhen Parts Co",
  });
  await h.call("contact_upsert", { name: "Ada Lovelace", email: "ada@example.com", company: "Analytical Engines Ltd" });
}
