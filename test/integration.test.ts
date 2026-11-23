/**
 * Runs against a real PostgreSQL when POSTGRES_TEST_ADMIN_URL points at a superuser connection
 * (a throwaway database — it creates and drops the `mcp_it` schema and `mcp_it_app` role).
 * Skipped otherwise, so `npm test` needs no database.
 *
 *   POSTGRES_TEST_ADMIN_URL=postgresql://postgres:pw@127.0.0.1:5432/postgres npm test
 */
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PostgresConnection } from "../src/config.js";
import { PostgresClient } from "../src/postgres/client.js";

const ADMIN_URL = process.env.POSTGRES_TEST_ADMIN_URL;

const conn = (url: string, overrides: Partial<PostgresConnection> = {}): PostgresConnection => ({
  connectionString: url,
  ssl: "off",
  applicationName: "mcp-postgres-it",
  statementTimeoutMs: 5000,
  connectionTimeoutMs: 5000,
  maxRows: 5,
  maxAffectedRows: 3,
  redactSecretColumns: true,
  allowSuperuser: false,
  ...overrides,
});

function appUrl(admin: string): string {
  const u = new URL(admin);
  u.username = "mcp_it_app";
  u.password = "mcp_it_pw";
  return u.toString();
}

describe.skipIf(!ADMIN_URL)("integration (real PostgreSQL)", () => {
  const admin = new pg.Client({ connectionString: ADMIN_URL });
  let app: PostgresClient;

  beforeAll(async () => {
    await admin.connect();
    await admin.query("DROP SCHEMA IF EXISTS mcp_it CASCADE");
    await admin.query("DROP ROLE IF EXISTS mcp_it_app");
    await admin.query("CREATE ROLE mcp_it_app LOGIN PASSWORD 'mcp_it_pw'");
    await admin.query("CREATE SCHEMA mcp_it AUTHORIZATION mcp_it_app");
    await admin.query(
      "CREATE TABLE mcp_it.users (id int PRIMARY KEY, email text NOT NULL, password_hash text, status text DEFAULT 'active')",
    );
    await admin.query("ALTER TABLE mcp_it.users OWNER TO mcp_it_app");
    await admin.query(
      "INSERT INTO mcp_it.users SELECT g, 'u' || g || '@x.io', 'hash' || g, CASE WHEN g <= 2 THEN 'stale' ELSE 'active' END FROM generate_series(1, 10) g",
    );
    app = new PostgresClient(conn(appUrl(ADMIN_URL!)));
  });

  afterAll(async () => {
    await app?.close();
    await admin.query("DROP SCHEMA IF EXISTS mcp_it CASCADE");
    await admin.query("DROP ROLE IF EXISTS mcp_it_app");
    await admin.end();
  });

  it("refuses to run as a superuser unless allowed", async () => {
    const su = new PostgresClient(conn(ADMIN_URL!));
    await expect(su.serverInfo()).rejects.toThrow(/superuser/);
    await su.close();
    const allowed = new PostgresClient(conn(ADMIN_URL!, { allowSuperuser: true }));
    await expect(allowed.serverInfo()).resolves.toHaveProperty("version");
    await allowed.close();
  });

  it("runs read queries, caps rows, and redacts secret columns", async () => {
    const out = await app.runQuery("SELECT * FROM mcp_it.users ORDER BY id");
    expect(out.rowCount).toBe(5);
    expect(out.truncated).toBe(true);
    expect(out.rows[0]).toMatchObject({ id: 1, password_hash: "[REDACTED]" });
  });

  it("binds params", async () => {
    const out = await app.runQuery("SELECT email FROM mcp_it.users WHERE id = $1", [3]);
    expect(out.rows).toEqual([{ email: "u3@x.io" }]);
  });

  it("cannot smuggle a second statement past the read-only transaction", async () => {
    await expect(app.runQuery("SELECT 1; DELETE FROM mcp_it.users")).rejects.toThrow();
    await expect(app.runQuery("SELECT 1) AS q; COMMIT; DELETE FROM mcp_it.users; SELECT (1")).rejects.toThrow();
    expect((await app.countMatching("mcp_it", "users", { status: ["active", "stale"] }))).toBe(10);
  });

  it("a data-modifying CTE is stopped by the READ ONLY transaction", async () => {
    // run_query's row-limit wrapper already refuses it; EXPLAIN ANALYZE runs it unwrapped, so the transaction must stop it.
    await expect(app.runQuery("WITH d AS (DELETE FROM mcp_it.users RETURNING id) SELECT * FROM d")).rejects.toThrow();
    await expect(
      app.explain("WITH d AS (DELETE FROM mcp_it.users RETURNING id) SELECT * FROM d", [], true),
    ).rejects.toThrow(/read-only transaction/);
    expect(await app.countMatching("mcp_it", "users", { status: ["active", "stale"] })).toBe(10);
  });

  it("explains without executing, and EXPLAIN ANALYZE only for reads", async () => {
    const plan = await app.explain("DELETE FROM mcp_it.users WHERE id = $1", [1]);
    expect(JSON.stringify(plan)).toContain("ModifyTable");
    expect(await app.countMatching("mcp_it", "users", { id: 1 })).toBe(1);
    await expect(app.explain("DELETE FROM mcp_it.users", [], true)).rejects.toThrow(/only accepted for read/);
  });

  it("describes and lists tables", async () => {
    const d = await app.describeTable("mcp_it", "users");
    expect((d.columns as Array<{ name: string }>).map((c) => c.name)).toEqual(["id", "email", "password_hash", "status"]);
    expect(JSON.stringify(d.constraints)).toContain("PRIMARY KEY");
    const tables = await app.listTables(["mcp_it"], false);
    expect(tables.map((t) => t.name)).toContain("users");
  });

  it("selects with filters and ordering", async () => {
    const out = await app.selectRows("mcp_it", "users", {
      columns: ["id", "status"],
      where: { status: "stale" },
      orderBy: [{ column: "id", desc: true }],
    });
    expect(out.rows).toEqual([
      { id: 2, status: "stale" },
      { id: 1, status: "stale" },
    ]);
  });

  it("inserts, updates within the cap, and rolls back over the cap", async () => {
    expect(await app.insertRows("mcp_it", "users", [{ id: 100, email: "n@x.io" }])).toBe(1);
    expect((await app.selectRows("mcp_it", "users", { where: { id: 100 } })).rows[0]).toMatchObject({ status: "active" });
    expect(await app.updateRows("mcp_it", "users", { status: "checked" }, { id: 100 })).toBe(1);
    await expect(app.updateRows("mcp_it", "users", { status: "x" }, { status: "active" })).rejects.toThrow(
      /POSTGRES_MAX_AFFECTED_ROWS/,
    );
    expect(await app.countMatching("mcp_it", "users", { status: "x" })).toBe(0);
  });

  it("the delete version moves when a matching row changes", async () => {
    const before = await app.matchVersion("mcp_it", "users", { status: "stale" });
    await admin.query("UPDATE mcp_it.users SET email = 'changed@x.io' WHERE id = 1");
    const after = await app.matchVersion("mcp_it", "users", { status: "stale" });
    expect(after).not.toBe(before);
    expect(await app.deleteRows("mcp_it", "users", { status: "stale" })).toBe(2);
  });

  it("creates an index concurrently and drops the table", async () => {
    const name = await app.createIndex("mcp_it", "users", { columns: ["email"] });
    expect(JSON.stringify((await app.describeTable("mcp_it", "users")).indexes)).toContain(name);
    const v = await app.tableVersion("mcp_it", "users");
    expect(v).toMatch(/^\d+:\d+:\d+$/);
    await app.dropTable("mcp_it", "users", false);
    expect(await app.tableVersion("mcp_it", "users")).toBeUndefined();
  });

  it("execute_sql runs one statement and refuses transaction control", async () => {
    const out = await app.executeSql("CREATE TABLE mcp_it.t (id int)");
    expect(out.command).toBe("CREATE");
    await expect(app.executeSql("COMMIT")).rejects.toThrow(/Transaction control/);
    await expect(app.executeSql("INSERT INTO mcp_it.t VALUES (1); DROP TABLE mcp_it.t")).rejects.toThrow();
    expect(await app.tableVersion("mcp_it", "t")).toBeDefined();
  });

  it("reads server, activity, stats, roles and extensions", async () => {
    expect(await app.serverInfo()).toHaveProperty("database");
    expect(await app.activeQueries(true)).toHaveProperty("rows");
    expect(await app.databaseStats()).toHaveProperty("connections_by_state");
    expect((await app.listRoles()).map((r) => r.name)).toContain("mcp_it_app");
    expect(Array.isArray(await app.listExtensions())).toBe(true);
  });
});
