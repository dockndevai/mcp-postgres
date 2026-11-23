/**
 * Thin wrapper over node-postgres.
 *
 * Every statement runs through the extended query protocol (one statement per call — no
 * `COMMIT; DROP …` smuggling), under the pool's statement_timeout. Reads run inside a
 * READ ONLY transaction that is always rolled back. Writes run in a transaction that rolls
 * back when more rows than POSTGRES_MAX_AFFECTED_ROWS would change.
 */
import pg from "pg";
import type { PoolClient, QueryResult } from "pg";
import type { PostgresConnection } from "../config.js";
import { redactRows } from "./redact.js";
import {
  EXPLAIN_KEYWORDS,
  assertReadOnlyStatement,
  buildWhere,
  leadingKeyword,
  normalizeStatement,
  qualified,
  quoteIdent,
  withRowLimit,
  type WhereValue,
} from "./sql.js";

export type Row = Record<string, unknown>;

export interface QueryOutput {
  columns: string[];
  rows: Row[];
  rowCount: number;
  truncated: boolean;
}

export interface SelectOptions {
  columns?: string[];
  where?: Record<string, WhereValue>;
  orderBy?: Array<{ column: string; desc?: boolean }>;
  limit?: number;
}

export class PostgresClient {
  private pool?: pg.Pool;
  private roleChecked?: Promise<void>;

  constructor(private readonly config: PostgresConnection) {}

  private getPool(): pg.Pool {
    if (!this.pool) {
      this.pool = new pg.Pool({
        connectionString: this.config.connectionString,
        ssl: this.config.ssl === "off" ? false : { rejectUnauthorized: this.config.ssl === "verify" },
        application_name: this.config.applicationName,
        statement_timeout: this.config.statementTimeoutMs,
        connectionTimeoutMillis: this.config.connectionTimeoutMs,
        max: 4,
        idleTimeoutMillis: 30_000,
      });
      // An idle client erroring (server restart, network drop) must not crash the process.
      this.pool.on("error", (err) => process.stderr.write(`[postgres-mcp] pool error: ${err.message}\n`));
    }
    return this.pool;
  }

  /** Superusers bypass GRANTs and can call any function, so they are refused unless explicitly allowed. */
  private async checkRole(conn: PoolClient): Promise<void> {
    const res = await this.q(conn, "SELECT current_user AS role, rolsuper FROM pg_roles WHERE rolname = current_user");
    const row = res.rows[0] as { role: string; rolsuper: boolean } | undefined;
    if (row?.rolsuper && !this.config.allowSuperuser) {
      throw new Error(
        `Connected role '${row.role}' is a superuser, which bypasses every privilege check. ` +
          "Connect as a least-privilege role, or set POSTGRES_ALLOW_SUPERUSER=true to accept the risk.",
      );
    }
  }

  private async connect(): Promise<PoolClient> {
    const conn = await this.getPool().connect();
    try {
      this.roleChecked ??= this.checkRole(conn).catch((err) => {
        this.roleChecked = undefined;
        throw err;
      });
      await this.roleChecked;
      return conn;
    } catch (err) {
      conn.release();
      throw err;
    }
  }

  /** Extended protocol: the server refuses more than one statement per call. */
  private q(conn: PoolClient, text: string, values: unknown[] = []): Promise<QueryResult> {
    return conn.query({ text, values, queryMode: "extended" } as pg.QueryConfig);
  }

  private async readTx<T>(fn: (conn: PoolClient) => Promise<T>): Promise<T> {
    const conn = await this.connect();
    try {
      await conn.query("BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY");
      // Take the snapshot now, so the transaction can no longer be switched to READ WRITE.
      await this.q(conn, "SELECT 1");
      return await fn(conn);
    } finally {
      await conn.query("ROLLBACK").catch(() => {});
      conn.release();
    }
  }

  private async writeTx<T>(fn: (conn: PoolClient) => Promise<T>): Promise<T> {
    const conn = await this.connect();
    try {
      await conn.query("BEGIN");
      const out = await fn(conn);
      await conn.query("COMMIT");
      return out;
    } catch (err) {
      await conn.query("ROLLBACK").catch(() => {});
      throw err;
    } finally {
      conn.release();
    }
  }

  private shape(res: QueryResult, limit = this.config.maxRows): QueryOutput {
    const rows = res.rows as Row[];
    return {
      columns: (res.fields ?? []).map((f) => f.name),
      rows: redactRows(rows.slice(0, limit), this.config.redactSecretColumns),
      rowCount: Math.min(rows.length, limit),
      truncated: rows.length > limit,
    };
  }

  private capAffected(res: QueryResult, what: string): number {
    const n = res.rowCount ?? 0;
    if (n > this.config.maxAffectedRows) {
      throw new Error(
        `${what} would affect ${n} rows, more than POSTGRES_MAX_AFFECTED_ROWS (${this.config.maxAffectedRows}); rolled back.`,
      );
    }
    return n;
  }

  async close(): Promise<void> {
    await this.pool?.end();
    this.pool = undefined;
  }

  // ---------------------------------------------------------------- reads

  async serverInfo(): Promise<Row> {
    return this.readTx(async (c) => {
      const res = await this.q(
        c,
        `SELECT version() AS version, current_database() AS database, current_user AS role,
                pg_size_pretty(pg_database_size(current_database())) AS size,
                now() - pg_postmaster_start_time() AS uptime,
                pg_is_in_recovery() AS in_recovery,
                current_setting('server_version_num')::int AS version_num`,
      );
      return res.rows[0] as Row;
    });
  }

  async listSchemas(): Promise<Row[]> {
    return this.readTx(async (c) => {
      const res = await this.q(
        c,
        `SELECT n.nspname AS schema, pg_get_userbyid(n.nspowner) AS owner,
                count(cl.oid) FILTER (WHERE cl.relkind IN ('r','p','v','m','f')) AS relations
           FROM pg_namespace n LEFT JOIN pg_class cl ON cl.relnamespace = n.oid
          GROUP BY n.oid, n.nspname, n.nspowner ORDER BY n.nspname`,
      );
      return res.rows as Row[];
    });
  }

  async listTables(schemas: string[] | undefined, includeSystem: boolean): Promise<Row[]> {
    return this.readTx(async (c) => {
      const res = await this.q(
        c,
        `SELECT n.nspname AS schema, cl.relname AS name,
                CASE cl.relkind WHEN 'r' THEN 'table' WHEN 'p' THEN 'partitioned table' WHEN 'v' THEN 'view'
                                WHEN 'm' THEN 'materialized view' WHEN 'f' THEN 'foreign table' END AS type,
                cl.reltuples::bigint AS estimated_rows,
                pg_size_pretty(pg_total_relation_size(cl.oid)) AS total_size
           FROM pg_class cl JOIN pg_namespace n ON n.oid = cl.relnamespace
          WHERE cl.relkind IN ('r','p','v','m','f')
            AND ($1::text[] IS NULL OR n.nspname = ANY($1))
            AND ($2 OR (n.nspname NOT IN ('pg_catalog','information_schema') AND n.nspname NOT LIKE 'pg\\_%'))
          ORDER BY 1, 2
          LIMIT 2000`,
        [schemas ?? null, includeSystem],
      );
      return res.rows as Row[];
    });
  }

  async describeTable(schema: string, table: string): Promise<Row> {
    return this.readTx(async (c) => {
      const rel = await this.q(
        c,
        `SELECT cl.oid, cl.relkind, cl.reltuples::bigint AS estimated_rows,
                pg_size_pretty(pg_total_relation_size(cl.oid)) AS total_size,
                pg_size_pretty(pg_relation_size(cl.oid)) AS table_size,
                obj_description(cl.oid, 'pg_class') AS comment
           FROM pg_class cl JOIN pg_namespace n ON n.oid = cl.relnamespace
          WHERE n.nspname = $1 AND cl.relname = $2`,
        [schema, table],
      );
      const info = rel.rows[0] as { oid: number } & Row | undefined;
      if (!info) throw new Error(`Relation ${schema}.${table} not found.`);
      const columns = await this.q(
        c,
        `SELECT a.attname AS name, format_type(a.atttypid, a.atttypmod) AS type, NOT a.attnotnull AS nullable,
                pg_get_expr(d.adbin, d.adrelid) AS "default", col_description(a.attrelid, a.attnum) AS comment
           FROM pg_attribute a LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
          WHERE a.attrelid = $1 AND a.attnum > 0 AND NOT a.attisdropped ORDER BY a.attnum`,
        [info.oid],
      );
      const constraints = await this.q(
        c,
        `SELECT conname AS name,
                CASE contype WHEN 'p' THEN 'primary key' WHEN 'f' THEN 'foreign key' WHEN 'u' THEN 'unique'
                             WHEN 'c' THEN 'check' WHEN 'x' THEN 'exclusion' ELSE contype::text END AS type,
                pg_get_constraintdef(oid) AS definition
           FROM pg_constraint WHERE conrelid = $1 ORDER BY contype, conname`,
        [info.oid],
      );
      const indexes = await this.q(
        c,
        `SELECT i.relname AS name, pg_get_indexdef(i.oid) AS definition, ix.indisunique AS unique,
                ix.indisprimary AS primary, pg_size_pretty(pg_relation_size(i.oid)) AS size,
                coalesce(s.idx_scan, 0) AS scans
           FROM pg_index ix JOIN pg_class i ON i.oid = ix.indexrelid
           LEFT JOIN pg_stat_all_indexes s ON s.indexrelid = ix.indexrelid
          WHERE ix.indrelid = $1 ORDER BY i.relname`,
        [info.oid],
      );
      const { oid: _oid, ...rest } = info;
      return {
        schema,
        table,
        ...rest,
        columns: columns.rows,
        constraints: constraints.rows,
        indexes: indexes.rows,
      };
    });
  }

  async selectRows(schema: string, table: string, opts: SelectOptions): Promise<QueryOutput> {
    const cols = opts.columns?.length ? opts.columns.map(quoteIdent).join(", ") : "*";
    const where = opts.where && Object.keys(opts.where).length ? buildWhere(opts.where) : undefined;
    const order = opts.orderBy?.length
      ? ` ORDER BY ${opts.orderBy.map((o) => `${quoteIdent(o.column)}${o.desc ? " DESC" : ""}`).join(", ")}`
      : "";
    const limit = Math.min(opts.limit ?? this.config.maxRows, this.config.maxRows);
    const sql = `SELECT ${cols} FROM ${qualified(schema, table)}${where ? ` WHERE ${where.clause}` : ""}${order} LIMIT ${limit + 1}`;
    return this.readTx(async (c) => this.shape(await this.q(c, sql, where?.values ?? []), limit));
  }

  async runQuery(sql: string, params: unknown[] = []): Promise<QueryOutput> {
    const statement = assertReadOnlyStatement(sql);
    return this.readTx(async (c) => this.shape(await this.q(c, withRowLimit(statement, this.config.maxRows), params)));
  }

  async explain(sql: string, params: unknown[] = [], analyze = false): Promise<unknown> {
    const statement = assertReadOnlyStatement(sql, EXPLAIN_KEYWORDS);
    if (analyze && !["select", "with", "values", "table"].includes(leadingKeyword(statement))) {
      throw new Error("EXPLAIN ANALYZE executes the statement, so it is only accepted for read statements.");
    }
    const options = analyze ? "FORMAT JSON, ANALYZE, BUFFERS" : "FORMAT JSON";
    return this.readTx(async (c) => {
      const res = await this.q(c, `EXPLAIN (${options}) ${statement}`, params);
      return (res.rows[0] as Record<string, unknown>)["QUERY PLAN"];
    });
  }

  async activeQueries(includeIdle: boolean): Promise<QueryOutput> {
    return this.readTx(async (c) =>
      this.shape(
        await this.q(
          c,
          `SELECT pid, usename AS role, datname AS database, application_name, client_addr::text, state,
                  wait_event_type, wait_event, backend_type,
                  now() - xact_start AS transaction_age, now() - query_start AS query_age,
                  left(query, 2000) AS query
             FROM pg_stat_activity
            WHERE pid <> pg_backend_pid() AND ($1 OR state IS DISTINCT FROM 'idle')
            ORDER BY query_start NULLS LAST`,
          [includeIdle],
        ),
      ),
    );
  }

  async databaseStats(): Promise<Row> {
    return this.readTx(async (c) => {
      const db = await this.q(
        c,
        `SELECT numbackends AS connections, xact_commit, xact_rollback, deadlocks, conflicts, temp_files,
                pg_size_pretty(temp_bytes) AS temp_bytes,
                round(100.0 * blks_hit / nullif(blks_hit + blks_read, 0), 2) AS cache_hit_pct,
                stats_reset
           FROM pg_stat_database WHERE datname = current_database()`,
      );
      const states = await this.q(
        c,
        `SELECT coalesce(state, backend_type) AS state, count(*)::int AS count
           FROM pg_stat_activity GROUP BY 1 ORDER BY 2 DESC`,
      );
      const settings = await this.q(
        c,
        `SELECT name, setting, unit FROM pg_settings
          WHERE name IN ('max_connections','shared_buffers','work_mem','maintenance_work_mem',
                         'effective_cache_size','statement_timeout','default_transaction_read_only')`,
      );
      return { ...(db.rows[0] as Row), connections_by_state: states.rows, settings: settings.rows };
    });
  }

  async listRoles(): Promise<Row[]> {
    // pg_roles masks rolpassword; it is never selected anyway.
    return this.readTx(async (c) => {
      const res = await this.q(
        c,
        `SELECT r.rolname AS name, r.rolsuper AS superuser, r.rolcreaterole AS create_role, r.rolcreatedb AS create_db,
                r.rolcanlogin AS can_login, r.rolreplication AS replication, r.rolbypassrls AS bypass_rls,
                r.rolconnlimit AS connection_limit, r.rolvaliduntil AS valid_until,
                ARRAY(SELECT b.rolname FROM pg_auth_members m JOIN pg_roles b ON b.oid = m.roleid
                       WHERE m.member = r.oid ORDER BY 1) AS member_of
           FROM pg_roles r WHERE r.rolname NOT LIKE 'pg\\_%' ORDER BY 1`,
      );
      return res.rows as Row[];
    });
  }

  async listExtensions(): Promise<Row[]> {
    return this.readTx(async (c) => {
      const res = await this.q(
        c,
        `SELECT e.extname AS name, e.extversion AS version, n.nspname AS schema, a.default_version AS latest
           FROM pg_extension e JOIN pg_namespace n ON n.oid = e.extnamespace
           LEFT JOIN pg_available_extensions a ON a.name = e.extname ORDER BY 1`,
      );
      return res.rows as Row[];
    });
  }

  async topQueries(limit: number, orderBy: "total_time" | "mean_time" | "calls"): Promise<QueryOutput> {
    return this.readTx(async (c) => {
      const ext = await this.q(c, "SELECT 1 FROM pg_extension WHERE extname = 'pg_stat_statements'");
      if (ext.rowCount === 0) {
        throw new Error("pg_stat_statements is not installed in this database (CREATE EXTENSION pg_stat_statements).");
      }
      const order = { total_time: "total_exec_time", mean_time: "mean_exec_time", calls: "calls" }[orderBy];
      const res = await this.q(
        c,
        `SELECT queryid::text, calls, round(total_exec_time::numeric, 1) AS total_ms,
                round(mean_exec_time::numeric, 2) AS mean_ms, rows,
                round(100.0 * shared_blks_hit / nullif(shared_blks_hit + shared_blks_read, 0), 2) AS cache_hit_pct,
                left(query, 2000) AS query
           FROM pg_stat_statements ORDER BY ${order} DESC LIMIT $1`,
        [Math.min(limit, this.config.maxRows)],
      );
      return this.shape(res);
    });
  }

  // ---------------------------------------------------------------- version probes

  /** Changes when the table is dropped/recreated, rewritten, or its columns change. */
  async tableVersion(schema: string, table: string): Promise<string | undefined> {
    return this.readTx(async (c) => {
      const res = await this.q(
        c,
        `SELECT cl.oid::text || ':' || cl.relfilenode::text || ':' || cl.relnatts::text AS v
           FROM pg_class cl JOIN pg_namespace n ON n.oid = cl.relnamespace
          WHERE n.nspname = $1 AND cl.relname = $2`,
        [schema, table],
      );
      return (res.rows[0] as { v: string } | undefined)?.v;
    });
  }

  /** Pins the set of rows a delete would touch: table identity + matching row count + a hash of their ctids. */
  async matchVersion(schema: string, table: string, where: Record<string, WhereValue>): Promise<string | undefined> {
    const version = await this.tableVersion(schema, table);
    if (!version) return undefined;
    const w = buildWhere(where);
    return this.readTx(async (c) => {
      const res = await this.q(
        c,
        `SELECT count(*)::text || ':' || coalesce(md5(string_agg(ctid::text || ':' || xmin::text, ',' ORDER BY ctid)), '-') AS v
           FROM ${qualified(schema, table)} WHERE ${w.clause}`,
        w.values,
      );
      return `${version}/${(res.rows[0] as { v: string }).v}`;
    });
  }

  async countMatching(schema: string, table: string, where: Record<string, WhereValue>): Promise<number> {
    const w = buildWhere(where);
    return this.readTx(async (c) => {
      const res = await this.q(c, `SELECT count(*)::int AS n FROM ${qualified(schema, table)} WHERE ${w.clause}`, w.values);
      return (res.rows[0] as { n: number }).n;
    });
  }

  /** Changes when the backend is replaced or starts a different query. */
  async backendVersion(pid: number): Promise<string | undefined> {
    return this.readTx(async (c) => {
      const res = await this.q(
        c,
        "SELECT backend_start::text || '/' || coalesce(query_start::text, '-') AS v FROM pg_stat_activity WHERE pid = $1",
        [pid],
      );
      return (res.rows[0] as { v: string } | undefined)?.v;
    });
  }

  async backendInfo(pid: number): Promise<Row | undefined> {
    return this.readTx(async (c) => {
      const res = await this.q(
        c,
        `SELECT pid, usename AS role, datname AS database, application_name, state, left(query, 300) AS query
           FROM pg_stat_activity WHERE pid = $1`,
        [pid],
      );
      return redactRows(res.rows as Row[], this.config.redactSecretColumns)[0];
    });
  }

  // ---------------------------------------------------------------- writes

  async insertRows(schema: string, table: string, rows: Row[]): Promise<number> {
    if (rows.length === 0) return 0;
    if (rows.length > this.config.maxAffectedRows) {
      throw new Error(`${rows.length} rows exceeds POSTGRES_MAX_AFFECTED_ROWS (${this.config.maxAffectedRows}).`);
    }
    const columns = [...new Set(rows.flatMap((r) => Object.keys(r)))];
    if (columns.length === 0) throw new Error("Rows have no columns.");
    const values: unknown[] = [];
    const tuples = rows.map(
      (r) =>
        `(${columns
          .map((col) => {
            if (!(col in r)) return "DEFAULT";
            values.push(r[col]);
            return `$${values.length}`;
          })
          .join(", ")})`,
    );
    const sql = `INSERT INTO ${qualified(schema, table)} (${columns.map(quoteIdent).join(", ")}) VALUES ${tuples.join(", ")}`;
    return this.writeTx(async (c) => (await this.q(c, sql, values)).rowCount ?? 0);
  }

  async updateRows(schema: string, table: string, set: Row, where: Record<string, WhereValue>): Promise<number> {
    const setCols = Object.keys(set);
    if (setCols.length === 0) throw new Error("Nothing to update: 'set' is empty.");
    const values = setCols.map((k) => set[k]);
    const assignments = setCols.map((col, i) => `${quoteIdent(col)} = $${i + 1}`).join(", ");
    const w = buildWhere(where, values.length + 1);
    const sql = `UPDATE ${qualified(schema, table)} SET ${assignments} WHERE ${w.clause}`;
    return this.writeTx(async (c) => this.capAffected(await this.q(c, sql, [...values, ...w.values]), "UPDATE"));
  }

  async deleteRows(schema: string, table: string, where: Record<string, WhereValue>): Promise<number> {
    const w = buildWhere(where);
    const sql = `DELETE FROM ${qualified(schema, table)} WHERE ${w.clause}`;
    return this.writeTx(async (c) => this.capAffected(await this.q(c, sql, w.values), "DELETE"));
  }

  async createIndex(
    schema: string,
    table: string,
    opts: { columns: string[]; name?: string; unique?: boolean; method?: string; concurrently?: boolean },
  ): Promise<string> {
    const method = opts.method ?? "btree";
    if (!/^[a-z_]+$/.test(method)) throw new Error(`Invalid index method '${method}'.`);
    const name = opts.name ?? `${table}_${opts.columns.join("_")}_idx`.slice(0, 63);
    const sql =
      `CREATE ${opts.unique ? "UNIQUE " : ""}INDEX ${opts.concurrently === false ? "" : "CONCURRENTLY "}IF NOT EXISTS ` +
      `${quoteIdent(name)} ON ${qualified(schema, table)} USING ${method} (${opts.columns.map(quoteIdent).join(", ")})`;
    const conn = await this.connect();
    try {
      // CREATE INDEX CONCURRENTLY cannot run inside a transaction block.
      await this.q(conn, sql);
    } finally {
      conn.release();
    }
    return name;
  }

  async analyzeTable(schema: string, table: string): Promise<void> {
    await this.writeTx(async (c) => {
      await this.q(c, `ANALYZE ${qualified(schema, table)}`);
    });
  }

  async cancelBackend(pid: number): Promise<boolean> {
    return this.writeTx(async (c) => (await this.q(c, "SELECT pg_cancel_backend($1) AS ok", [pid])).rows[0].ok as boolean);
  }

  async terminateBackend(pid: number): Promise<boolean> {
    return this.writeTx(async (c) => (await this.q(c, "SELECT pg_terminate_backend($1) AS ok", [pid])).rows[0].ok as boolean);
  }

  async dropTable(schema: string, table: string, cascade: boolean): Promise<void> {
    await this.writeTx(async (c) => {
      await this.q(c, `DROP TABLE ${qualified(schema, table)}${cascade ? " CASCADE" : ""}`);
    });
  }

  /** Arbitrary single statement, committed. Only reachable through execute_sql (admin + POSTGRES_ALLOW_RAW_SQL). */
  async executeSql(sql: string, params: unknown[] = []): Promise<QueryOutput & { command: string }> {
    const statement = normalizeStatement(sql);
    if (!statement) throw new Error("Empty SQL statement.");
    const keyword = leadingKeyword(statement);
    if (["begin", "start", "commit", "end", "rollback", "abort", "savepoint", "release", "prepare"].includes(keyword)) {
      throw new Error(`Transaction control ('${keyword.toUpperCase()}') is managed by the server and refused.`);
    }
    return this.writeTx(async (c) => {
      const res = await this.q(c, statement, params);
      const rowCount = ["insert", "update", "delete", "merge"].includes(keyword)
        ? this.capAffected(res, keyword.toUpperCase())
        : (res.rowCount ?? 0);
      return { command: res.command, ...this.shape(res), rowCount };
    });
  }
}
