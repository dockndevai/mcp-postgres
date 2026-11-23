/**
 * Security policy engine.
 *
 * Flags decide which tools are registered (capability vs. access mode) and
 * whether each individual call is allowed at runtime (schema scoping, protected
 * schemas, destructive-op gating, free-form SQL, dry-run). Pure logic — fully unit-testable.
 */

export type Capability = "read" | "write" | "admin";
export type AccessMode = "read-only" | "read-write" | "admin";

const MODE_RANK: Record<AccessMode, number> = {
  "read-only": 0,
  "read-write": 1,
  admin: 2,
};

const CAPABILITY_RANK: Record<Capability, number> = {
  read: 0,
  write: 1,
  admin: 2,
};

/** Schemas that hold the catalog itself. Readable, never mutated, when protectSystemSchemas is on. */
const SYSTEM_SCHEMAS = ["pg_catalog", "information_schema", "pg_toast"];

export interface SecurityConfig {
  mode: AccessMode;
  /** If set, only these schemas may be touched. Empty = all. */
  schemaAllowlist: string[];
  /** Schemas that can be read but never mutated. */
  protectedSchemas: string[];
  /** Treat pg_catalog, information_schema, pg_toast and any pg_* schema as protected. */
  protectSystemSchemas: boolean;
  /** Destructive operations (delete_rows, drop_table, terminate_backend) require this to be true. */
  allowDelete: boolean;
  /** Registers execute_sql (arbitrary SQL, admin mode). Off by default. */
  allowRawSql: boolean;
  /** Validate + log writes without sending them to the database. */
  dryRun: boolean;
  /** Emit a JSON audit line to stderr per guarded operation. */
  auditLog: boolean;
  /** Refuse destructive ops that no human can approve (no elicitation support) instead of trusting the flags alone. */
  requireHumanApproval: boolean;
}

export class PolicyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PolicyError";
  }
}

export interface GuardContext {
  tool: string;
  capability: Capability;
  /** Schema the operation targets, if any. */
  schema?: string;
  /**
   * Free-form SQL: the statement can reach any schema, so it cannot be held to the
   * schema allowlist. Refused while an allowlist is configured.
   */
  freeform?: boolean;
  /** Destructive operation — needs allowDelete. */
  destructive?: boolean;
}

export class SecurityPolicy {
  constructor(private readonly config: SecurityConfig) {}

  get mode(): AccessMode {
    return this.config.mode;
  }

  get rawSqlEnabled(): boolean {
    return this.config.allowRawSql;
  }

  isCapabilityEnabled(capability: Capability): boolean {
    return CAPABILITY_RANK[capability] <= MODE_RANK[this.config.mode];
  }

  isSchemaAllowed(schema: string): boolean {
    if (this.config.schemaAllowlist.length === 0) return true;
    return this.config.schemaAllowlist.includes(schema);
  }

  isSchemaProtected(schema: string): boolean {
    if (this.config.protectSystemSchemas && (SYSTEM_SCHEMAS.includes(schema) || schema.startsWith("pg_"))) return true;
    return this.config.protectedSchemas.includes(schema);
  }

  guard(ctx: GuardContext): { dryRun: boolean } {
    if (!this.isCapabilityEnabled(ctx.capability)) {
      this.audit(ctx, "DENY", `capability '${ctx.capability}' exceeds mode '${this.config.mode}'`);
      throw new PolicyError(
        `Operation '${ctx.tool}' requires '${ctx.capability}' access but the server runs in '${this.config.mode}' mode.`,
      );
    }

    if (ctx.freeform && this.config.schemaAllowlist.length > 0) {
      this.audit(ctx, "DENY", "free-form SQL cannot be held to the schema allowlist");
      throw new PolicyError(
        `Operation '${ctx.tool}' runs free-form SQL, which can reach any schema, so it is refused while POSTGRES_SCHEMA_ALLOWLIST is set. ` +
          "Use the structured tools (list_tables, describe_table, select_rows, …), or scope the database role with GRANTs and clear the allowlist.",
      );
    }

    if (ctx.schema !== undefined) {
      if (!this.isSchemaAllowed(ctx.schema)) {
        this.audit(ctx, "DENY", `schema '${ctx.schema}' not in allowlist`);
        throw new PolicyError(
          `Schema '${ctx.schema}' is not in the configured allowlist (POSTGRES_SCHEMA_ALLOWLIST).`,
        );
      }
      if (ctx.capability !== "read" && this.isSchemaProtected(ctx.schema)) {
        this.audit(ctx, "DENY", `schema '${ctx.schema}' is protected`);
        throw new PolicyError(
          `Schema '${ctx.schema}' is protected (system schema or POSTGRES_PROTECTED_SCHEMAS); mutations are refused.`,
        );
      }
    }

    if (ctx.destructive && !this.config.allowDelete) {
      this.audit(ctx, "DENY", "delete not enabled");
      throw new PolicyError(
        `Destructive operation '${ctx.tool}' is disabled. Set POSTGRES_ALLOW_DELETE=true to enable it.`,
      );
    }

    const dryRun = ctx.capability !== "read" && this.config.dryRun;
    this.audit(ctx, dryRun ? "DRY_RUN" : "ALLOW");
    return { dryRun };
  }

  private audit(ctx: GuardContext, decision: string, reason?: string): void {
    if (!this.config.auditLog) return;
    const line = {
      ts: new Date().toISOString(),
      audit: "postgres-mcp",
      decision,
      tool: ctx.tool,
      capability: ctx.capability,
      schema: ctx.schema ?? null,
      freeform: ctx.freeform ?? false,
      destructive: ctx.destructive ?? false,
      ...(reason ? { reason } : {}),
    };
    process.stderr.write(`${JSON.stringify(line)}\n`);
  }
}
