/**
 * Pure SQL helpers: identifier quoting, WHERE building, and the checks that keep
 * free-form statements on the read path. No I/O — unit-tested.
 */

export function quoteIdent(name: string): string {
  if (typeof name !== "string" || name.length === 0) throw new Error("Identifier must be a non-empty string.");
  if (name.includes("\u0000")) throw new Error("Identifier must not contain NUL bytes.");
  if (name.length > 63) throw new Error(`Identifier '${name.slice(0, 20)}…' exceeds PostgreSQL's 63-character limit.`);
  return `"${name.replace(/"/g, '""')}"`;
}

export function qualified(schema: string, table: string): string {
  return `${quoteIdent(schema)}.${quoteIdent(table)}`;
}

export type WhereValue = string | number | boolean | null | Array<string | number | boolean>;

/**
 * Equality-only WHERE clause: `{ id: 5, deleted_at: null, status: ["a","b"] }`
 * becomes `"id" = $1 AND "deleted_at" IS NULL AND "status" = ANY($2)`.
 * Values are always parameters, never interpolated.
 */
export function buildWhere(
  where: Record<string, WhereValue>,
  firstParam = 1,
): { clause: string; values: unknown[] } {
  const parts: string[] = [];
  const values: unknown[] = [];
  for (const [column, value] of Object.entries(where)) {
    if (value === null) {
      parts.push(`${quoteIdent(column)} IS NULL`);
    } else if (Array.isArray(value)) {
      values.push(value);
      parts.push(`${quoteIdent(column)} = ANY($${firstParam + values.length - 1})`);
    } else {
      values.push(value);
      parts.push(`${quoteIdent(column)} = $${firstParam + values.length - 1}`);
    }
  }
  return { clause: parts.join(" AND "), values };
}

/** Strip leading whitespace and SQL comments, and trailing semicolons/whitespace. */
export function normalizeStatement(sql: string): string {
  let s = sql;
  for (;;) {
    const before = s;
    s = s.replace(/^\s+/, "");
    if (s.startsWith("--")) s = s.replace(/^--[^\n]*(\n|$)/, "");
    else if (s.startsWith("/*")) {
      const end = s.indexOf("*/");
      s = end === -1 ? "" : s.slice(end + 2);
    }
    if (s === before) break;
  }
  return s.replace(/[\s;]+$/, "");
}

export function leadingKeyword(sql: string): string {
  const m = /^[a-z]+/i.exec(normalizeStatement(sql));
  return m ? m[0].toLowerCase() : "";
}

/** Statements run_query accepts. Anything else is refused before it reaches the database. */
export const READ_KEYWORDS = ["select", "with", "values", "table", "show"];
/** Statements explain_query accepts (EXPLAIN without ANALYZE does not execute them). */
export const EXPLAIN_KEYWORDS = [...READ_KEYWORDS.filter((k) => k !== "show"), "insert", "update", "delete", "merge"];

/**
 * Functions with side effects that a READ ONLY transaction does not stop (signals, server files,
 * config reloads, other connections). Not exhaustive — the database role's privileges are the
 * real control — but it refuses the well-known ones on the read path.
 */
const SIDE_EFFECT_FUNCTIONS =
  /\b(pg_terminate_backend|pg_cancel_backend|pg_reload_conf|pg_rotate_logfile|pg_promote|pg_switch_wal|pg_create_restore_point|pg_create_\w*replication_slot|pg_drop_replication_slot|pg_log_backend_memory_contexts|lo_import|lo_export|lo_unlink|lo_from_bytea|lo_put|pg_read_file|pg_read_binary_file|pg_ls_\w+|pg_stat_file|pg_file_write|pg_file_unlink|pg_file_rename|dblink\w*|set_config|pg_advisory_\w+|pg_try_advisory_\w+|pg_notify|pg_logical_emit_message|pg_sleep\w*)\s*\(/i;

export function assertReadOnlyStatement(sql: string, allowed: string[] = READ_KEYWORDS): string {
  const statement = normalizeStatement(sql);
  if (statement.length === 0) throw new Error("Empty SQL statement.");
  const keyword = leadingKeyword(statement);
  if (!allowed.includes(keyword)) {
    throw new Error(
      `Only ${allowed.map((k) => k.toUpperCase()).join(" / ")} statements are accepted here (got '${keyword.toUpperCase() || "?"}').`,
    );
  }
  const fn = SIDE_EFFECT_FUNCTIONS.exec(statement);
  if (fn) throw new Error(`Function '${fn[1]}' has side effects and is refused on the read path.`);
  return statement;
}

/** Wrap a row-returning statement so the database itself stops after `limit + 1` rows. */
export function withRowLimit(statement: string, limit: number): string {
  const keyword = leadingKeyword(statement);
  if (keyword === "show") return statement;
  return `SELECT * FROM (\n${statement}\n) AS mcp_q LIMIT ${limit + 1}`;
}
