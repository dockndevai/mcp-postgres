import { z } from "zod";
import type { ToolDef } from "./types.js";
import { jsonResult, textResult } from "./types.js";
import { identifier, requiredWhereSchema, rowSchema } from "./schemas.js";

export const writeTools: ToolDef[] = [
  {
    name: "insert_rows",
    capability: "write",
    config: {
      title: "Insert rows",
      description:
        "Insert rows into one table (parameterized; missing columns use their DEFAULT). " +
        "At most POSTGRES_MAX_AFFECTED_ROWS rows per call.",
      inputSchema: {
        schema: identifier.describe("Schema name"),
        table: identifier.describe("Table name"),
        rows: z.array(rowSchema).min(1).describe("Rows as column → value objects"),
      },
    },
    handler: async (args, { client, policy }) => {
      const schema = args.schema as string;
      const table = args.table as string;
      const rows = args.rows as Array<Record<string, unknown>>;
      const { dryRun } = policy.guard({ tool: "insert_rows", capability: "write", schema });
      if (dryRun) return textResult(`[dry-run] Would insert ${rows.length} row(s) into ${schema}.${table}.`);
      return jsonResult({ inserted: await client.insertRows(schema, table, rows), schema, table });
    },
  },
  {
    name: "update_rows",
    capability: "write",
    config: {
      title: "Update rows",
      description:
        "Update rows matching equality filters. A non-empty `where` is required, and the change rolls back " +
        "if it would touch more than POSTGRES_MAX_AFFECTED_ROWS rows.",
      inputSchema: {
        schema: identifier.describe("Schema name"),
        table: identifier.describe("Table name"),
        set: rowSchema.describe("Columns to change, e.g. { \"status\": \"closed\" }"),
        where: requiredWhereSchema.describe("Equality filters selecting the rows, e.g. { \"id\": 42 }"),
      },
    },
    handler: async (args, { client, policy }) => {
      const schema = args.schema as string;
      const table = args.table as string;
      const where = args.where as never;
      const { dryRun } = policy.guard({ tool: "update_rows", capability: "write", schema });
      if (dryRun) {
        const n = await client.countMatching(schema, table, where);
        return textResult(`[dry-run] Would update ${n} row(s) in ${schema}.${table} set ${JSON.stringify(args.set)}.`);
      }
      return jsonResult({ updated: await client.updateRows(schema, table, args.set as never, where), schema, table });
    },
  },
  {
    name: "create_index",
    capability: "write",
    config: {
      title: "Create index",
      description:
        "Create an index (CONCURRENTLY by default, so writes are not blocked; IF NOT EXISTS). " +
        "Check describe_table and explain_query first.",
      inputSchema: {
        schema: identifier.describe("Schema name"),
        table: identifier.describe("Table name"),
        columns: z.array(identifier).min(1).describe("Indexed columns, in order"),
        name: identifier.optional().describe("Index name (default <table>_<columns>_idx)"),
        unique: z.boolean().optional().describe("UNIQUE index (default false)"),
        method: z.enum(["btree", "hash", "gin", "gist", "brin", "spgist"]).optional().describe("Access method (default btree)"),
        concurrently: z.boolean().optional().describe("Build without locking writes (default true)"),
      },
    },
    handler: async (args, { client, policy }) => {
      const schema = args.schema as string;
      const table = args.table as string;
      const columns = args.columns as string[];
      const { dryRun } = policy.guard({ tool: "create_index", capability: "write", schema });
      if (dryRun) return textResult(`[dry-run] Would create index on ${schema}.${table} (${columns.join(", ")}).`);
      const name = await client.createIndex(schema, table, {
        columns,
        name: args.name as string | undefined,
        unique: args.unique as boolean | undefined,
        method: args.method as string | undefined,
        concurrently: args.concurrently as boolean | undefined,
      });
      return jsonResult({ created: true, index: name, schema, table });
    },
  },
  {
    name: "analyze_table",
    capability: "write",
    idempotent: true,
    config: {
      title: "Analyze table",
      description: "Refresh the planner statistics for one table (ANALYZE). Safe and non-blocking for reads and writes.",
      inputSchema: {
        schema: identifier.describe("Schema name"),
        table: identifier.describe("Table name"),
      },
    },
    handler: async (args, { client, policy }) => {
      const schema = args.schema as string;
      const table = args.table as string;
      const { dryRun } = policy.guard({ tool: "analyze_table", capability: "write", schema });
      if (dryRun) return textResult(`[dry-run] Would ANALYZE ${schema}.${table}.`);
      await client.analyzeTable(schema, table);
      return jsonResult({ analyzed: true, schema, table });
    },
  },
  {
    name: "cancel_query",
    capability: "write",
    config: {
      title: "Cancel query",
      description:
        "Cancel the running query of one backend (pg_cancel_backend). The session stays connected; its transaction rolls back.",
      inputSchema: { pid: z.number().int().positive().describe("Backend pid from list_active_queries") },
    },
    handler: async (args, { client, policy, confirm }) => {
      const pid = args.pid as number;
      const { dryRun } = policy.guard({ tool: "cancel_query", capability: "write" });
      if (dryRun) return textResult(`[dry-run] Would cancel the query running on backend ${pid}.`);
      const backend = await client.backendInfo(pid);
      if (!backend) return textResult(`No backend with pid ${pid}.`);
      const ok = await confirm.confirm({
        action: "cancel the running query of backend",
        target: String(pid),
        details: { role: String(backend.role ?? ""), query: String(backend.query ?? "") },
        probe: () => client.backendVersion(pid),
      });
      if (!ok.approved) return textResult(`Cancel not performed — ${ok.reason}.`);
      return jsonResult({ cancelled: await client.cancelBackend(pid), pid });
    },
  },
];
