# Security

`mcp-postgres` gives an AI agent access to a PostgreSQL database. Treat it like
any other privileged automation and grant it the least access it needs.

## Principles

- **Start read-only.** Leave `POSTGRES_MODE=read-only` until you specifically need
  the agent to make changes. Tools above the current mode are never registered.
- **Scope with GRANTs, not just flags.** The flags are defence in depth; the
  primary control is the privileges of the role the server logs in as. Use a
  dedicated least-privilege role (see the README). Connecting as a superuser is
  refused unless `POSTGRES_ALLOW_SUPERUSER=true`, because a superuser bypasses
  every privilege check and can call any server function.
- **Reads cannot write.** Every read runs in `BEGIN … READ ONLY` that is always
  rolled back, over the extended query protocol (one statement per call, so
  `…; COMMIT; DROP …` cannot be appended). `run_query` accepts only
  `SELECT`/`WITH`/`VALUES`/`TABLE`/`SHOW` and refuses well-known side-effect
  functions that a read-only transaction does not stop (`pg_terminate_backend`,
  `pg_read_file`, `lo_import`, `dblink`, `set_config`, `pg_sleep`, …). That list is
  not exhaustive — the role's privileges remain the real control.
- **Constrain scope.** Use `POSTGRES_SCHEMA_ALLOWLIST` to limit which schemas the
  agent can touch. While it is set, free-form SQL is refused, because a statement
  can reach any schema; the structured tools are held to the allowlist.
- **Protect system and critical schemas.** `pg_catalog`, `information_schema`,
  `pg_toast` and `pg_*` are protected by default; add business-critical schemas to
  `POSTGRES_PROTECTED_SCHEMAS`. Protected schemas can be read but never mutated.
- **Bound every change.** `update_rows` and `delete_rows` require a non-empty
  `where`, and any change that would touch more than `POSTGRES_MAX_AFFECTED_ROWS`
  rows is rolled back.
- **Gate deletion explicitly.** `delete_rows`, `drop_table` and
  `terminate_backend` require both `admin` mode and `POSTGRES_ALLOW_DELETE=true`.
  `execute_sql` is not even registered without `POSTGRES_ALLOW_RAW_SQL=true`.
- **Require a human for destructive ops.** Set `POSTGRES_REQUIRE_HUMAN_APPROVAL=true`
  so destructive tools are refused when the client cannot show an approval prompt.
  Each approval is bound to the exact tool and arguments (fingerprint) and to the
  target's version — the table's identity for `drop_table`, the exact set of
  matching rows (count + row versions) for `delete_rows`, the backend's current
  query for `cancel_query`/`terminate_backend`. If the target changed while the
  human was deciding, the action is refused. `drop_table` also asks the human to
  type the table name. Approval receipts are written to the audit log
  (`"audit":"approval"`, with `approvedBy` = `human` or `flag-only`).
- **Preview with dry-run.** `POSTGRES_DRY_RUN=true` validates and logs write intent
  without changing the database.
- **Keep the audit log on.** `POSTGRES_AUDIT_LOG=true` (default) writes a JSON line
  per guarded operation to stderr.

## Handling of credentials

- The connection string is read from `POSTGRES_URL` (or the standard `PG*`
  variables) and never logged or returned in tool results; credentials echoed in
  driver errors are masked.
- `list_roles` never selects password hashes.
- Values in columns named like `password`, `secret`, `token`, `api_key`,
  `private_key` or `credential` are replaced with `[REDACTED]`
  (`POSTGRES_REDACT_SECRET_COLUMNS`, default on), and inline passwords in query
  text (`list_active_queries`, `get_top_queries`) are masked. Column-name matching
  cannot catch secrets stored under other names — keep such tables out of the
  role's grants.

## Reporting a vulnerability

Please open a private security advisory on the GitHub repository rather than a
public issue.
