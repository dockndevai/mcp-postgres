import { describe, expect, it } from "vitest";
import { REDACTED, isSecretColumn, redactRows, redactText } from "../src/postgres/redact.js";

describe("redactRows", () => {
  it("masks secret-like columns and keeps the rest", () => {
    const [row] = redactRows([{ id: 1, email: "a@b.c", password_hash: "x", api_key: "k", resetToken: "t", note: null }], true);
    expect(row).toEqual({ id: 1, email: "a@b.c", password_hash: REDACTED, api_key: REDACTED, resetToken: REDACTED, note: null });
  });

  it("can be turned off", () => {
    expect(redactRows([{ password: "p" }], false)[0]?.password).toBe("p");
  });

  it("summarises bytea and truncates huge text", () => {
    const [row] = redactRows([{ blob: Buffer.alloc(10), body: "x".repeat(5000) }], true);
    expect(row?.blob).toBe("<bytea 10 bytes>");
    expect(String(row?.body)).toMatch(/truncated, 5000 chars/);
  });

  it("recognises common secret column names", () => {
    for (const c of ["password", "PASSWD", "client_secret", "access_token", "apikey", "private_key", "credentials"]) {
      expect(isSecretColumn(c), c).toBe(true);
    }
    expect(isSecretColumn("email")).toBe(false);
  });
});

describe("redactText", () => {
  it("masks inline passwords in statements", () => {
    expect(redactText("ALTER ROLE app PASSWORD 'hunter2'")).not.toContain("hunter2");
    expect(redactText("CREATE USER x WITH ENCRYPTED PASSWORD 'it''s'")).not.toContain("it''s");
  });

  it("masks credentials in connection strings", () => {
    const out = redactText("connect postgresql://app:s3cret@db:5432/x failed; password=abc");
    expect(out).not.toMatch(/s3cret|abc/);
    expect(out).toContain("postgresql://app:");
  });
});
