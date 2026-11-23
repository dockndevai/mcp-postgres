import { afterEach, describe, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ElicitRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import type { AppConfig } from "../src/config.js";
import { PostgresClient } from "../src/postgres/client.js";
import { buildServer } from "../src/server.js";

const config = (overrides: Partial<AppConfig["security"]> = {}): AppConfig => ({
  connection: {
    ssl: "off",
    applicationName: "t",
    statementTimeoutMs: 1000,
    connectionTimeoutMs: 1000,
    maxRows: 10,
    maxAffectedRows: 10,
    redactSecretColumns: true,
    allowSuperuser: false,
  },
  security: {
    mode: "admin",
    schemaAllowlist: [],
    protectedSchemas: [],
    protectSystemSchemas: true,
    allowDelete: true,
    allowRawSql: false,
    dryRun: false,
    auditLog: false,
    requireHumanApproval: false,
    ...overrides,
  },
});

type Answer = { action: "accept" | "decline"; content?: Record<string, unknown> };

async function connect(opts: {
  security?: Partial<AppConfig["security"]>;
  answer?: (message: string) => Answer | Promise<Answer>;
  elicits?: boolean;
}) {
  const { server } = buildServer(config(opts.security));
  const prompts: string[] = [];
  const client = new Client({ name: "t", version: "0" }, { capabilities: opts.elicits === false ? {} : { elicitation: {} } });
  if (opts.elicits !== false) {
    client.setRequestHandler(ElicitRequestSchema, async (req) => {
      prompts.push(req.params.message);
      return (await opts.answer?.(req.params.message)) ?? { action: "accept", content: { confirm: true, typed: "public.orders" } };
    });
  }
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(a), client.connect(b)]);
  return { client, prompts };
}

const text = (r: unknown) => ((r as { content: Array<{ text: string }> }).content[0]?.text ?? "");

afterEach(() => vi.restoreAllMocks());

describe("tool registration", () => {
  it("read-only advertises only read tools", async () => {
    const { client } = await connect({ security: { mode: "read-only" } });
    const names = (await client.listTools()).tools.map((t) => t.name);
    expect(names).toContain("run_query");
    expect(names).not.toContain("insert_rows");
    expect(names).not.toContain("drop_table");
  });

  it("execute_sql stays hidden in admin mode until POSTGRES_ALLOW_RAW_SQL is set", async () => {
    const hidden = (await (await connect({})).client.listTools()).tools.map((t) => t.name);
    expect(hidden).toContain("drop_table");
    expect(hidden).not.toContain("execute_sql");
    const shown = (await (await connect({ security: { allowRawSql: true } })).client.listTools()).tools.map((t) => t.name);
    expect(shown).toContain("execute_sql");
  });
});

describe("drop_table approval (end to end)", () => {
  it("shows the tool, arguments, version and fingerprint, requires the typed name, then drops", async () => {
    vi.spyOn(PostgresClient.prototype, "tableVersion").mockResolvedValue("16384:16384:3");
    const drop = vi.spyOn(PostgresClient.prototype, "dropTable").mockResolvedValue();
    const { client, prompts } = await connect({});
    const res = await client.callTool({ name: "drop_table", arguments: { schema: "public", table: "orders" } });
    expect(text(res)).toContain('"dropped": true');
    expect(drop).toHaveBeenCalledWith("public", "orders", false);
    expect(prompts[0]).toContain("tool: drop_table");
    expect(prompts[0]).toContain("resource version: 16384:16384:3");
    expect(prompts[0]).toMatch(/fingerprint: [0-9a-f]{16}/);
  });

  it("does NOT drop when the human types the wrong name", async () => {
    vi.spyOn(PostgresClient.prototype, "tableVersion").mockResolvedValue("v1");
    const drop = vi.spyOn(PostgresClient.prototype, "dropTable").mockResolvedValue();
    const { client } = await connect({ answer: () => ({ action: "accept", content: { confirm: true, typed: "public.other" } }) });
    const res = await client.callTool({ name: "drop_table", arguments: { schema: "public", table: "orders" } });
    expect(drop).not.toHaveBeenCalled();
    expect(text(res)).toMatch(/cancelled/i);
  });

  it("does NOT drop when the table was recreated while the human was deciding", async () => {
    const versions = ["v1", "v2"];
    vi.spyOn(PostgresClient.prototype, "tableVersion").mockImplementation(async () => versions.shift());
    const drop = vi.spyOn(PostgresClient.prototype, "dropTable").mockResolvedValue();
    const { client } = await connect({});
    const res = await client.callTool({ name: "drop_table", arguments: { schema: "public", table: "orders" } });
    expect(drop).not.toHaveBeenCalled();
    expect(text(res)).toMatch(/cancelled/i);
  });

  it("refuses protected schemas before any prompt", async () => {
    const drop = vi.spyOn(PostgresClient.prototype, "dropTable").mockResolvedValue();
    const { client, prompts } = await connect({});
    const res = await client.callTool({ name: "drop_table", arguments: { schema: "pg_catalog", table: "pg_class" } });
    expect(text(res)).toMatch(/Policy denied: .*protected/);
    expect(prompts).toHaveLength(0);
    expect(drop).not.toHaveBeenCalled();
  });
});

describe("delete_rows approval", () => {
  it("does NOT delete when the matching rows changed while the human was deciding", async () => {
    vi.spyOn(PostgresClient.prototype, "countMatching").mockResolvedValue(2);
    const versions = ["t/2:aaa", "t/3:bbb"];
    vi.spyOn(PostgresClient.prototype, "matchVersion").mockImplementation(async () => versions.shift());
    const del = vi.spyOn(PostgresClient.prototype, "deleteRows").mockResolvedValue(2);
    const { client, prompts } = await connect({});
    await client.callTool({ name: "delete_rows", arguments: { schema: "public", table: "orders", where: { status: "stale" } } });
    expect(prompts[0]).toContain("delete 2 row(s)");
    expect(del).not.toHaveBeenCalled();
  });

  it("rejects an empty where", async () => {
    const del = vi.spyOn(PostgresClient.prototype, "deleteRows").mockResolvedValue(0);
    const { client } = await connect({});
    const res = await client.callTool({ name: "delete_rows", arguments: { schema: "public", table: "orders", where: {} } });
    expect((res as { isError?: boolean }).isError).toBe(true);
    expect(del).not.toHaveBeenCalled();
  });
});

describe("POSTGRES_REQUIRE_HUMAN_APPROVAL", () => {
  it("refuses a drop when the client cannot prompt a human", async () => {
    vi.spyOn(PostgresClient.prototype, "tableVersion").mockResolvedValue("v1");
    const drop = vi.spyOn(PostgresClient.prototype, "dropTable").mockResolvedValue();
    const { client } = await connect({ security: { requireHumanApproval: true }, elicits: false });
    await client.callTool({ name: "drop_table", arguments: { schema: "public", table: "orders" } });
    expect(drop).not.toHaveBeenCalled();
  });
});

describe("errors never leak credentials", () => {
  it("masks a connection string echoed in a driver error", async () => {
    vi.spyOn(PostgresClient.prototype, "serverInfo").mockRejectedValue(new Error("cannot reach postgresql://app:s3cret@db/x"));
    const { client } = await connect({ security: { mode: "read-only" } });
    const res = await client.callTool({ name: "get_server_info", arguments: {} });
    expect(text(res)).not.toContain("s3cret");
  });
});
