import { z } from "zod";
import { redactText } from "../postgres/redact.js";
import type { ToolDef } from "./types.js";
import { jsonResult } from "./types.js";
import { identifier, paramsSchema, whereSchema } from "./schemas.js";

export const readTools: ToolDef[] = [
  {
    name: "get_server_info",
    capability: "read",
    config: {
      title: "Server info",
      description: "PostgreSQL version, current database and role, database size, uptime, and whether it is a replica.",
      inputSchema: {},
    },
    handler: async (_args, { client, policy }) => {
      policy.guard({ tool: "get_server_info", capability: "read" });
      return jsonResult(await client.serverInfo());
    },
  },
  {
    name: "list_schemas",
    capability: "read",
    config: {
      title: "List schemas",
      description: "List schemas with owner and relation count (filtered to POSTGRES_SCHEMA_ALLOWLIST when set).",
      inputSchema: {},
    },
    handler: async (_args, { client, policy }) => {
      policy.guard({ tool: "list_schemas", capability: "read" });
      const rows = await client.listSchemas();
      return jsonResult(rows.filter((r) => policy.isSchemaAllowed(String(r.schema))));
    },
  },
  {
    name: "list_tables",
    capability: "read",
    config: {
      title: "List tables",
      description: "List tables, views, and materialized views with estimated row counts and on-disk size.",
      inputSchema: {
        schema: identifier.optional().describe("Only this schema (default: every allowed non-system schema)"),
        includeSystem: z.boolean().optional().describe("Include pg_catalog / information_schema (default false)"),
      },
    },
    handler: async (args, { client, policy }) => {
      const schema = args.schema as string | undefined;
      policy.guard({ tool: "list_tables", capability: "read", schema });
      const rows = await client.listTables(schema ? [schema] : undefined, Boolean(args.includeSystem));
      return jsonResult(rows.filter((r) => policy.isSchemaAllowed(String(r.schema))));
    },
  },
  {
    name: "describe_table",
    capability: "read",
    config: {
      title: "Describe table",
      description: "Columns (type, nullability, default), constraints, indexes (with scan counts), size, and estimated rows.",
      inputSchema: {
        schema: identifier.describe("Schema name, e.g. public"),
        table: identifier.describe("Table or view name"),
      },
    },
    handler: async (args, { client, policy }) => {
      const schema = args.schema as string;
      policy.guard({ tool: "describe_table", capability: "read", schema });
      return jsonResult(await client.describeTable(schema, args.table as string));
    },
  },
  {
    name: "select_rows",
    capability: "read",
    config: {
      title: "Select rows",
      description:
        "Read rows from one table with equality filters — no SQL needed, and held to the schema allowlist. " +
        "Results are capped at POSTGRES_MAX_ROWS; secret-like columns are redacted.",
      inputSchema: {
        schema: identifier.describe("Schema name"),
        table: identifier.describe("Table or view name"),
        columns: z.array(identifier).optional().describe("Columns to return (default all)"),
        where: whereSchema.optional().describe("Equality filters, e.g. { \"status\": \"open\", \"deleted_at\": null }"),
        orderBy: z
          .array(z.object({ column: identifier, desc: z.boolean().optional() }))
          .optional()
          .describe("Sort order, e.g. [{ \"column\": \"created_at\", \"desc\": true }]"),
        limit: z.number().int().min(1).optional().describe("Max rows (capped at POSTGRES_MAX_ROWS)"),
      },
    },
    handler: async (args, { client, policy }) => {
      const schema = args.schema as string;
      policy.guard({ tool: "select_rows", capability: "read", schema });
      return jsonResult(
        await client.selectRows(schema, args.table as string, {
          columns: args.columns as string[] | undefined,
          where: args.where as never,
          orderBy: args.orderBy as never,
          limit: args.limit as number | undefined,
        }),
      );
    },
  },
  {
    name: "run_query",
    capability: "read",
    config: {
      title: "Run read-only query",
      description:
        "Run one SELECT / WITH / VALUES / TABLE / SHOW statement inside a READ ONLY transaction that is always rolled back. " +
        "Use $1, $2 … placeholders with `params` for values. Results are capped at POSTGRES_MAX_ROWS. " +
        "Refused while POSTGRES_SCHEMA_ALLOWLIST is set (free-form SQL can reach any schema) — use select_rows then.",
      inputSchema: {
        sql: z.string().min(1).describe("A single read statement, e.g. SELECT id, total FROM orders WHERE status = $1"),
        params: paramsSchema.optional().describe("Values for $1, $2 … placeholders"),
      },
    },
    handler: async (args, { client, policy }) => {
      policy.guard({ tool: "run_query", capability: "read", freeform: true });
      return jsonResult(await client.runQuery(args.sql as string, (args.params as unknown[] | undefined) ?? []));
    },
  },
  {
    name: "explain_query",
    capability: "read",
    config: {
      title: "Explain query plan",
      description:
        "Show the planner's JSON plan for one statement (SELECT/WITH/VALUES/TABLE, or INSERT/UPDATE/DELETE/MERGE — not executed). " +
        "`analyze: true` executes read statements inside a rolled-back READ ONLY transaction for real timings. " +
        "Refused while POSTGRES_SCHEMA_ALLOWLIST is set.",
      inputSchema: {
        sql: z.string().min(1).describe("The statement to explain"),
        params: paramsSchema.optional().describe("Values for $1, $2 … placeholders"),
        analyze: z.boolean().optional().describe("Run EXPLAIN ANALYZE, BUFFERS (read statements only; default false)"),
      },
    },
    handler: async (args, { client, policy }) => {
      policy.guard({ tool: "explain_query", capability: "read", freeform: true });
      return jsonResult(
        await client.explain(args.sql as string, (args.params as unknown[] | undefined) ?? [], Boolean(args.analyze)),
      );
    },
  },
  {
    name: "list_active_queries",
    capability: "read",
    config: {
      title: "Active queries",
      description:
        "Sessions from pg_stat_activity: role, state, wait event, transaction/query age, and query text (inline secrets masked).",
      inputSchema: {
        includeIdle: z.boolean().optional().describe("Include idle sessions (default false)"),
      },
    },
    handler: async (args, { client, policy }) => {
      policy.guard({ tool: "list_active_queries", capability: "read" });
      const out = await client.activeQueries(Boolean(args.includeIdle));
      out.rows = out.rows.map((r) => ({ ...r, query: typeof r.query === "string" ? redactText(r.query) : r.query }));
      return jsonResult(out);
    },
  },
  {
    name: "get_database_stats",
    capability: "read",
    config: {
      title: "Database stats",
      description: "Connections by state, commits/rollbacks, deadlocks, temp usage, cache hit ratio, and key memory settings.",
      inputSchema: {},
    },
    handler: async (_args, { client, policy }) => {
      policy.guard({ tool: "get_database_stats", capability: "read" });
      return jsonResult(await client.databaseStats());
    },
  },
  {
    name: "get_top_queries",
    capability: "read",
    config: {
      title: "Top queries",
      description: "Most expensive statements from pg_stat_statements (requires the extension), with inline secrets masked.",
      inputSchema: {
        orderBy: z.enum(["total_time", "mean_time", "calls"]).optional().describe("Rank by (default total_time)"),
        limit: z.number().int().min(1).max(100).optional().describe("How many (default 20)"),
      },
    },
    handler: async (args, { client, policy }) => {
      policy.guard({ tool: "get_top_queries", capability: "read" });
      const out = await client.topQueries(
        (args.limit as number | undefined) ?? 20,
        (args.orderBy as "total_time" | "mean_time" | "calls" | undefined) ?? "total_time",
      );
      out.rows = out.rows.map((r) => ({ ...r, query: typeof r.query === "string" ? redactText(r.query) : r.query }));
      return jsonResult(out);
    },
  },
  {
    name: "list_roles",
    capability: "read",
    config: {
      title: "List roles",
      description: "Roles with their attributes (superuser, login, replication, bypass RLS …) and memberships. Never returns passwords.",
      inputSchema: {},
    },
    handler: async (_args, { client, policy }) => {
      policy.guard({ tool: "list_roles", capability: "read" });
      return jsonResult(await client.listRoles());
    },
  },
  {
    name: "list_extensions",
    capability: "read",
    config: {
      title: "List extensions",
      description: "Installed extensions with their version, schema, and the newest available version.",
      inputSchema: {},
    },
    handler: async (_args, { client, policy }) => {
      policy.guard({ tool: "list_extensions", capability: "read" });
      return jsonResult(await client.listExtensions());
    },
  },
];
