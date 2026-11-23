/**
 * Configuration from environment variables.
 */
import type { AccessMode, SecurityConfig } from "./security.js";

export interface PostgresConnection {
  /** libpq connection string. When unset, the standard PGHOST/PGUSER/PGDATABASE/… variables apply. */
  connectionString?: string;
  /** TLS: off, require (encrypt, no CA check), or verify (encrypt + verify the server certificate). */
  ssl: "off" | "require" | "verify";
  applicationName: string;
  /** Per-statement timeout in ms, applied to every query the server runs. */
  statementTimeoutMs: number;
  connectionTimeoutMs: number;
  /** Maximum rows returned to the model by any query tool. */
  maxRows: number;
  /** Write tools roll back when a statement would touch more rows than this. */
  maxAffectedRows: number;
  /** Replace values in password/secret/token-like columns with "[REDACTED]". */
  redactSecretColumns: boolean;
  /** Allow connecting as a superuser role (refused by default — superusers bypass read-only safeguards). */
  allowSuperuser: boolean;
}

export interface AppConfig {
  connection: PostgresConnection;
  security: SecurityConfig;
}

function bool(name: string, fallback: boolean): boolean {
  const v = process.env[name];
  if (v === undefined || v === "") return fallback;
  return ["1", "true", "yes", "on"].includes(v.toLowerCase());
}

function list(name: string): string[] {
  const v = process.env[name];
  if (!v) return [];
  return v
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

function num(name: string, fallback: number, min = 1): number {
  const v = process.env[name];
  if (v === undefined || v === "") return fallback;
  const n = Number(v);
  if (!Number.isInteger(n) || n < min) throw new Error(`Invalid ${name} '${v}'. Expected an integer >= ${min}.`);
  return n;
}

function parseMode(): AccessMode {
  const raw = (process.env.POSTGRES_MODE ?? "read-only").toLowerCase();
  if (raw === "read-only" || raw === "read-write" || raw === "admin") return raw;
  throw new Error(`Invalid POSTGRES_MODE '${raw}'. Expected one of: read-only, read-write, admin.`);
}

function parseSsl(): PostgresConnection["ssl"] {
  const raw = (process.env.POSTGRES_SSL ?? "off").toLowerCase();
  if (["off", "false", "0", "disable"].includes(raw)) return "off";
  if (raw === "require" || raw === "true") return "require";
  if (raw === "verify" || raw === "verify-full") return "verify";
  throw new Error(`Invalid POSTGRES_SSL '${raw}'. Expected off, require, or verify.`);
}

export function loadConfig(): AppConfig {
  // The server starts without a connection string so it can advertise its tools
  // (introspection); connection errors surface on first use.
  const connectionString = process.env.POSTGRES_URL || undefined;
  if (!connectionString && !process.env.PGHOST && !process.env.PGDATABASE) {
    process.stderr.write(
      "[postgres-mcp] WARNING: POSTGRES_URL (or PGHOST/PGDATABASE) not set; libpq defaults apply. Set it before running tools.\n",
    );
  }
  return {
    connection: {
      connectionString,
      ssl: parseSsl(),
      applicationName: process.env.POSTGRES_APP_NAME || "mcp-postgres",
      statementTimeoutMs: num("POSTGRES_STATEMENT_TIMEOUT_MS", 15000),
      connectionTimeoutMs: num("POSTGRES_CONNECTION_TIMEOUT_MS", 10000),
      maxRows: num("POSTGRES_MAX_ROWS", 200),
      maxAffectedRows: num("POSTGRES_MAX_AFFECTED_ROWS", 1000),
      redactSecretColumns: bool("POSTGRES_REDACT_SECRET_COLUMNS", true),
      allowSuperuser: bool("POSTGRES_ALLOW_SUPERUSER", false),
    },
    security: {
      mode: parseMode(),
      schemaAllowlist: list("POSTGRES_SCHEMA_ALLOWLIST"),
      protectedSchemas: list("POSTGRES_PROTECTED_SCHEMAS"),
      protectSystemSchemas: bool("POSTGRES_PROTECT_SYSTEM_SCHEMAS", true),
      allowDelete: bool("POSTGRES_ALLOW_DELETE", false),
      allowRawSql: bool("POSTGRES_ALLOW_RAW_SQL", false),
      dryRun: bool("POSTGRES_DRY_RUN", false),
      auditLog: bool("POSTGRES_AUDIT_LOG", true),
      requireHumanApproval: bool("POSTGRES_REQUIRE_HUMAN_APPROVAL", false),
    },
  };
}
