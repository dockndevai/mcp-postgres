import { describe, expect, it } from "vitest";
import {
  EXPLAIN_KEYWORDS,
  assertReadOnlyStatement,
  buildWhere,
  normalizeStatement,
  qualified,
  quoteIdent,
  withRowLimit,
} from "../src/postgres/sql.js";

describe("quoteIdent", () => {
  it("quotes and escapes embedded double quotes", () => {
    expect(quoteIdent("orders")).toBe('"orders"');
    expect(quoteIdent('a"; DROP TABLE x; --')).toBe('"a""; DROP TABLE x; --"');
    expect(qualified("public", "Orders")).toBe('"public"."Orders"');
  });

  it("rejects empty, NUL, and over-long identifiers", () => {
    expect(() => quoteIdent("")).toThrow();
    expect(() => quoteIdent("a\u0000b")).toThrow();
    expect(() => quoteIdent("x".repeat(64))).toThrow(/63/);
  });
});

describe("buildWhere", () => {
  it("parameterizes values and handles null and lists", () => {
    const w = buildWhere({ id: 5, deleted_at: null, status: ["a", "b"] });
    expect(w.clause).toBe('"id" = $1 AND "deleted_at" IS NULL AND "status" = ANY($2)');
    expect(w.values).toEqual([5, ["a", "b"]]);
  });

  it("numbers placeholders after earlier parameters", () => {
    expect(buildWhere({ id: 1 }, 3).clause).toBe('"id" = $3');
  });

  it("never interpolates values", () => {
    const w = buildWhere({ name: "x' OR '1'='1" });
    expect(w.clause).not.toContain("OR");
  });
});

describe("assertReadOnlyStatement", () => {
  it("accepts read statements, ignoring leading comments and trailing semicolons", () => {
    expect(assertReadOnlyStatement("  -- hi\n/* c */ select 1;  ")).toBe("select 1");
    for (const sql of ["WITH x AS (SELECT 1) SELECT * FROM x", "VALUES (1)", "TABLE orders", "SHOW work_mem"]) {
      expect(() => assertReadOnlyStatement(sql)).not.toThrow();
    }
  });

  it("refuses writes, DDL, transaction control and SET", () => {
    for (const sql of [
      "DELETE FROM orders",
      "drop table orders",
      "COMMIT",
      "BEGIN",
      "SET TRANSACTION READ WRITE",
      "set role postgres",
      "COPY orders TO PROGRAM 'x'",
      "CALL proc()",
      "DO $$ BEGIN END $$",
      "",
    ]) {
      expect(() => assertReadOnlyStatement(sql), sql).toThrow();
    }
  });

  it("refuses side-effect functions a READ ONLY transaction would not stop", () => {
    for (const sql of [
      "SELECT pg_terminate_backend(123)",
      "select PG_CANCEL_BACKEND (1)",
      "SELECT pg_read_file('/etc/passwd')",
      "SELECT * FROM dblink('host=x', 'DELETE FROM t') AS t(a int)",
      "SELECT set_config('default_transaction_read_only', 'off', false)",
      "SELECT pg_reload_conf()",
      "SELECT lo_import('/etc/passwd')",
      "SELECT pg_sleep(100)",
    ]) {
      expect(() => assertReadOnlyStatement(sql), sql).toThrow(/side effects/);
    }
  });

  it("explain accepts DML (it is not executed) but not DDL", () => {
    expect(() => assertReadOnlyStatement("DELETE FROM t WHERE id = 1", EXPLAIN_KEYWORDS)).not.toThrow();
    expect(() => assertReadOnlyStatement("DROP TABLE t", EXPLAIN_KEYWORDS)).toThrow();
  });
});

describe("withRowLimit", () => {
  it("wraps row-returning statements so the database stops early", () => {
    expect(withRowLimit("SELECT * FROM t", 10)).toBe("SELECT * FROM (\nSELECT * FROM t\n) AS mcp_q LIMIT 11");
  });

  it("leaves SHOW alone", () => {
    expect(withRowLimit("SHOW work_mem", 10)).toBe("SHOW work_mem");
  });

  it("a trailing line comment cannot swallow the closing parenthesis", () => {
    expect(withRowLimit(normalizeStatement("SELECT 1 -- note"), 5)).toContain("\n) AS mcp_q");
  });
});
