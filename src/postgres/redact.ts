/**
 * Keep credentials away from the model.
 *
 * - Column values whose name looks like a secret are replaced (configurable).
 * - Free text (query text from pg_stat_activity, error messages) has inline
 *   passwords and connection-string credentials masked.
 * - Long cells are truncated and binary values summarised, so one row cannot flood the context.
 */

const SECRET_COLUMN = /(password|passwd|secret|token|api_?key|private_?key|credential)/i;
const MAX_CELL_CHARS = 4000;

export const REDACTED = "[REDACTED]";

export function isSecretColumn(name: string): boolean {
  return SECRET_COLUMN.test(name);
}

export function redactText(text: string): string {
  return text
    .replace(/(postgres(?:ql)?:\/\/[^:/@\s]+:)[^@\s]+@/gi, `$1${REDACTED}@`)
    .replace(/((?:password|passwd|secret|token|api_?key)\s*(?:=|:|=>)?\s*)'(?:[^']|'')*'/gi, `$1'${REDACTED}'`)
    .replace(/((?:password|passwd)=)[^\s&;]+/gi, `$1${REDACTED}`);
}

function cell(value: unknown): unknown {
  if (value === null || value === undefined) return value;
  if (Buffer.isBuffer(value)) return `<bytea ${value.length} bytes>`;
  if (typeof value === "string" && value.length > MAX_CELL_CHARS) {
    return `${value.slice(0, MAX_CELL_CHARS)}… [truncated, ${value.length} chars]`;
  }
  if (typeof value === "bigint") return value.toString();
  return value;
}

export function redactRows(
  rows: Array<Record<string, unknown>>,
  redactSecretColumns: boolean,
): Array<Record<string, unknown>> {
  return rows.map((row) => {
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(row)) {
      out[key] = redactSecretColumns && value !== null && isSecretColumn(key) ? REDACTED : cell(value);
    }
    return out;
  });
}
