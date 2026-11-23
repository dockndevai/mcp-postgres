import { describe, expect, it } from "vitest";
import { PolicyError, SecurityPolicy, type SecurityConfig } from "../src/security.js";

function makePolicy(overrides: Partial<SecurityConfig> = {}): SecurityPolicy {
  return new SecurityPolicy({
    mode: "read-only",
    schemaAllowlist: [],
    protectedSchemas: [],
    protectSystemSchemas: true,
    allowDelete: false,
    allowRawSql: false,
    dryRun: false,
    auditLog: false,
    requireHumanApproval: false,
    ...overrides,
  });
}

describe("capability gating", () => {
  it("read-only enables read only", () => {
    const p = makePolicy();
    expect(p.isCapabilityEnabled("read")).toBe(true);
    expect(p.isCapabilityEnabled("write")).toBe(false);
    expect(p.isCapabilityEnabled("admin")).toBe(false);
  });

  it("read-write enables read+write, not admin", () => {
    const p = makePolicy({ mode: "read-write" });
    expect(p.isCapabilityEnabled("write")).toBe(true);
    expect(p.isCapabilityEnabled("admin")).toBe(false);
  });
});

describe("guard: capability vs mode", () => {
  it("rejects writes in read-only", () => {
    expect(() => makePolicy().guard({ tool: "insert_rows", capability: "write", schema: "public" })).toThrow(PolicyError);
  });

  it("rejects admin in read-write", () => {
    expect(() =>
      makePolicy({ mode: "read-write", allowDelete: true }).guard({ tool: "drop_table", capability: "admin", schema: "public", destructive: true }),
    ).toThrow(/admin/);
  });
});

describe("schema allowlist", () => {
  const p = makePolicy({ mode: "admin", schemaAllowlist: ["app"], allowDelete: true });

  it("allows listed schemas", () => {
    expect(() => p.guard({ tool: "select_rows", capability: "read", schema: "app" })).not.toThrow();
  });

  it("refuses unlisted schemas, for reads too", () => {
    expect(() => p.guard({ tool: "select_rows", capability: "read", schema: "billing" })).toThrow(/allowlist/);
  });

  it("refuses free-form SQL while an allowlist is set", () => {
    expect(() => p.guard({ tool: "run_query", capability: "read", freeform: true })).toThrow(/free-form SQL/);
    expect(() => p.guard({ tool: "execute_sql", capability: "admin", freeform: true })).toThrow(PolicyError);
  });

  it("allows free-form SQL when no allowlist is set", () => {
    expect(() => makePolicy().guard({ tool: "run_query", capability: "read", freeform: true })).not.toThrow();
  });
});

describe("protected schemas", () => {
  const p = makePolicy({ mode: "admin", allowDelete: true, protectedSchemas: ["audit"] });

  it("system schemas are readable", () => {
    expect(() => p.guard({ tool: "describe_table", capability: "read", schema: "pg_catalog" })).not.toThrow();
  });

  it("system schemas are never mutated", () => {
    for (const schema of ["pg_catalog", "information_schema", "pg_toast", "pg_temp_3"]) {
      expect(() => p.guard({ tool: "insert_rows", capability: "write", schema })).toThrow(/protected/);
    }
  });

  it("configured protected schemas are never mutated, even in admin with deletes on", () => {
    expect(() => p.guard({ tool: "drop_table", capability: "admin", schema: "audit", destructive: true })).toThrow(/protected/);
  });

  it("system protection can be turned off explicitly", () => {
    const q = makePolicy({ mode: "read-write", protectSystemSchemas: false });
    expect(q.isSchemaProtected("pg_catalog")).toBe(false);
  });
});

describe("destructive gating", () => {
  it("refuses destructive ops without POSTGRES_ALLOW_DELETE", () => {
    const p = makePolicy({ mode: "admin" });
    expect(() => p.guard({ tool: "delete_rows", capability: "admin", schema: "public", destructive: true })).toThrow(
      /POSTGRES_ALLOW_DELETE/,
    );
  });

  it("allows destructive ops with the flag", () => {
    const p = makePolicy({ mode: "admin", allowDelete: true });
    expect(p.guard({ tool: "delete_rows", capability: "admin", schema: "public", destructive: true })).toEqual({ dryRun: false });
  });
});

describe("dry-run", () => {
  it("applies to writes, never reads", () => {
    const p = makePolicy({ mode: "read-write", dryRun: true });
    expect(p.guard({ tool: "insert_rows", capability: "write", schema: "public" }).dryRun).toBe(true);
    expect(p.guard({ tool: "select_rows", capability: "read", schema: "public" }).dryRun).toBe(false);
  });
});
