import { z } from "zod";
import type { ToolDef } from "./types.js";
import { jsonResult, textResult } from "./types.js";
import { identifier, paramsSchema, requiredWhereSchema } from "./schemas.js";

/**
 * Admin tools are the most privileged: only registered in admin mode. The destructive
 * ones additionally require POSTGRES_ALLOW_DELETE=true, and execute_sql is not even
 * registered without POSTGRES_ALLOW_RAW_SQL=true.
 */
export const adminTools: ToolDef[] = [
  {
    name: "delete_rows",
    capability: "admin",
    config: {
      title: "Delete rows",
      description:
        "Delete rows matching equality filters. Requires admin mode AND POSTGRES_ALLOW_DELETE=true and a non-empty `where`; " +
        "rolls back if more than POSTGRES_MAX_AFFECTED_ROWS rows match. Irreversible.",
      inputSchema: {
        schema: identifier.describe("Schema name"),
        table: identifier.describe("Table name"),
        where: requiredWhereSchema.describe("Equality filters selecting the rows, e.g. { \"id\": 42 }"),
      },
    },
    handler: async (args, { client, policy, confirm }) => {
      const schema = args.schema as string;
      const table = args.table as string;
      const where = args.where as never;
      const { dryRun } = policy.guard({ tool: "delete_rows", capability: "admin", schema, destructive: true });
      const matching = await client.countMatching(schema, table, where);
      if (dryRun) return textResult(`[dry-run] Would delete ${matching} row(s) from ${schema}.${table}.`);
      const ok = await confirm.confirm({
        action: `delete ${matching} row(s) from`,
        target: `${schema}.${table}`,
        details: { matching_rows: matching },
        probe: () => client.matchVersion(schema, table, where),
      });
      if (!ok.approved) return textResult(`Deletion cancelled — ${ok.reason}.`);
      return jsonResult({ deleted: await client.deleteRows(schema, table, where), schema, table });
    },
  },
  {
    name: "drop_table",
    capability: "admin",
    config: {
      title: "Drop table",
      description:
        "Permanently drop a table and its data. Requires admin mode AND POSTGRES_ALLOW_DELETE=true, and the human must type the table name. Irreversible.",
      inputSchema: {
        schema: identifier.describe("Schema name"),
        table: identifier.describe("Table name"),
        cascade: z.boolean().optional().describe("Also drop dependent views and foreign keys (default false)"),
      },
    },
    handler: async (args, { client, policy, confirm }) => {
      const schema = args.schema as string;
      const table = args.table as string;
      const cascade = Boolean(args.cascade);
      const { dryRun } = policy.guard({ tool: "drop_table", capability: "admin", schema, destructive: true });
      if (dryRun) return textResult(`[dry-run] Would drop table ${schema}.${table}${cascade ? " CASCADE" : ""}.`);
      const ok = await confirm.confirm({
        action: `drop table${cascade ? " (CASCADE, including dependent objects)" : ""} and all its data`,
        target: `${schema}.${table}`,
        typed: true,
        probe: () => client.tableVersion(schema, table),
      });
      if (!ok.approved) return textResult(`Drop cancelled — ${ok.reason}.`);
      await client.dropTable(schema, table, cascade);
      return jsonResult({ dropped: true, schema, table, cascade });
    },
  },
  {
    name: "terminate_backend",
    capability: "admin",
    config: {
      title: "Terminate backend",
      description:
        "Disconnect one session (pg_terminate_backend); its open transaction rolls back. Requires admin mode AND POSTGRES_ALLOW_DELETE=true.",
      inputSchema: { pid: z.number().int().positive().describe("Backend pid from list_active_queries") },
    },
    handler: async (args, { client, policy, confirm }) => {
      const pid = args.pid as number;
      const { dryRun } = policy.guard({ tool: "terminate_backend", capability: "admin", destructive: true });
      if (dryRun) return textResult(`[dry-run] Would terminate backend ${pid}.`);
      const backend = await client.backendInfo(pid);
      if (!backend) return textResult(`No backend with pid ${pid}.`);
      const ok = await confirm.confirm({
        action: "terminate the session of backend",
        target: String(pid),
        details: { role: String(backend.role ?? ""), state: String(backend.state ?? ""), query: String(backend.query ?? "") },
        probe: () => client.backendVersion(pid),
      });
      if (!ok.approved) return textResult(`Terminate cancelled — ${ok.reason}.`);
      return jsonResult({ terminated: await client.terminateBackend(pid), pid });
    },
  },
  {
    name: "execute_sql",
    capability: "admin",
    destructive: true,
    enabledWhen: (policy) => policy.rawSqlEnabled,
    config: {
      title: "Execute SQL",
      description:
        "Run ONE arbitrary SQL statement (DDL or DML) and commit it. Only registered when POSTGRES_ALLOW_RAW_SQL=true (admin mode); " +
        "the human approves the exact statement. Bypasses the structured tools' safeguards, so prefer them.",
      inputSchema: {
        sql: z.string().min(1).describe("A single SQL statement"),
        params: paramsSchema.optional().describe("Values for $1, $2 … placeholders"),
      },
    },
    handler: async (args, { client, policy, confirm }) => {
      const sql = args.sql as string;
      const { dryRun } = policy.guard({ tool: "execute_sql", capability: "admin", freeform: true });
      if (dryRun) return textResult(`[dry-run] Would execute: ${sql}`);
      const ok = await confirm.confirm({ action: "execute this SQL statement and commit", target: sql });
      if (!ok.approved) return textResult(`Statement not executed — ${ok.reason}.`);
      return jsonResult(await client.executeSql(sql, (args.params as unknown[] | undefined) ?? []));
    },
  },
];
