# mcp-postgres

[![CI](https://github.com/dockndevai/mcp-postgres/actions/workflows/ci.yml/badge.svg)](https://github.com/dockndevai/mcp-postgres/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](./LICENSE)
[![npm](https://img.shields.io/npm/v/@dockndevai/mcp-postgres)](https://www.npmjs.com/package/@dockndevai/mcp-postgres)

A [Model Context Protocol](https://modelcontextprotocol.io) server for **PostgreSQL**. It lets an MCP-capable client (Claude Desktop, Claude Code, Cursor, …) **explore schemas, query data, read query plans, and diagnose a live database** — and, when you allow it, make governed changes — with behaviour controlled entirely by flags.

Safe by default: it starts read-only, runs every read inside a `READ ONLY` transaction that is always rolled back, refuses superuser connections, can be scoped to an allowlist of schemas, protects system schemas from mutation, caps how many rows any change can touch, and gates destructive operations behind an explicit opt-in plus a human approval bound to the exact action.

> Operating PostgreSQL on Kubernetes with the Percona operator (scaling, PgBouncer, backups, PITR)? That is [`mcp-percona-pg`](https://github.com/dockndevai/mcp-percona-pg). This server talks SQL to any PostgreSQL 13+ database.

## Features

- **Explore** — schemas, tables/views with sizes and row estimates, full table descriptions (columns, constraints, indexes with scan counts).
- **Query** — structured `select_rows` (no SQL needed, schema-scoped) and free-form `run_query` for one `SELECT`/`WITH`/`VALUES`/`TABLE`/`SHOW` statement with `$1` parameters.
- **Tune** — `explain_query` (JSON plans; `EXPLAIN ANALYZE` for reads in a rolled-back transaction), top statements from `pg_stat_statements`, `create_index` (CONCURRENTLY), `analyze_table`.
- **Diagnose** — active sessions and waits, connection/cache/deadlock stats, roles and extensions; cancel a runaway query.
- **Change** — parameterized `insert_rows` / `update_rows`, and in admin mode `delete_rows`, `drop_table`, `terminate_backend`, and (opt-in) `execute_sql`.
- **Access modes** — `read-only` → `read-write` → `admin`, layered so a mode never exposes tools above its level.

## Security model

| Concern | Flag | Default | Effect |
| --- | --- | --- | --- |
| What can the server do? | `POSTGRES_MODE` | `read-only` | `read-only` exposes inspection and queries; `read-write` adds inserts/updates/indexes; `admin` adds deletes and drops. Tools above the mode are **never registered**. |
| Read path | *(always on)* | — | Reads run in `BEGIN … READ ONLY` (always rolled back) over the extended protocol, so a second statement (`…; COMMIT; DROP …`) cannot be smuggled in. `run_query` accepts only read statements and refuses well-known side-effect functions (`pg_terminate_backend`, `pg_read_file`, `dblink`, `set_config`, …). |
| Superuser connections | `POSTGRES_ALLOW_SUPERUSER` | `false` | A superuser bypasses every privilege check, so connecting as one is refused. Use a least-privilege role. |
| Which schemas are in scope? | `POSTGRES_SCHEMA_ALLOWLIST` | *(all)* | When set, other schemas are refused — and free-form SQL (`run_query`, `explain_query`, `execute_sql`) is refused, since it can reach any schema; use the structured tools. |
| Protect system schemas | `POSTGRES_PROTECT_SYSTEM_SCHEMAS` | `true` | `pg_catalog`, `information_schema`, `pg_toast`, `pg_*` can be read but never mutated. |
| Protect specific schemas | `POSTGRES_PROTECTED_SCHEMAS` | *(none)* | Additional read-only-forever schemas. |
| Blast radius of a change | `POSTGRES_MAX_AFFECTED_ROWS` | `1000` | An insert/update/delete that would touch more rows rolls back. `update_rows`/`delete_rows` require a non-empty `where`. |
| Result size | `POSTGRES_MAX_ROWS` | `200` | Rows returned to the model per call; the database stops early. |
| Secrets in results | `POSTGRES_REDACT_SECRET_COLUMNS` | `true` | Values in `password`/`secret`/`token`/`api_key`/… columns are replaced with `[REDACTED]`; inline passwords in query text and connection strings in errors are masked. |
| Can it delete? | `POSTGRES_ALLOW_DELETE` | `false` | `delete_rows` / `drop_table` / `terminate_backend` need this **and** admin mode. |
| Raw SQL | `POSTGRES_ALLOW_RAW_SQL` | `false` | `execute_sql` is **not registered** without this (and admin mode). |
| Statement timeout | `POSTGRES_STATEMENT_TIMEOUT_MS` | `15000` | Applied to every statement the server runs. |
| Preview without touching the database | `POSTGRES_DRY_RUN` | `false` | Write/admin tools validate + log intent, then return. |
| Audit trail | `POSTGRES_AUDIT_LOG` | `true` | Emits a JSON line to stderr per guarded operation. |
| Interactive confirmation | *(automatic)* | — | Destructive & high-impact actions prompt the human to approve via MCP elicitation. The prompt shows the tool, the exact arguments and a fingerprint; the target's version (table identity, the exact set of matching rows, the backend's current query) is pinned across the prompt and the action is refused if it changed; `drop_table` also asks the human to type the table name; a prompt nobody answers is a refusal. |
| Require a human | `POSTGRES_REQUIRE_HUMAN_APPROVAL` | `false` | When `true`, destructive ops are **refused** if the client cannot elicit (instead of falling back to the `*_ALLOW_*` gate alone). |
| AI risk guard | `POSTGRES_GUARD_MODE` | `off` | Optional [laya-guard](https://github.com/dockndevai/laya-guard) check on every mutating call (`monitor` / `enforce`); it can only add a confirmation or block, never grant. |

## Tools

**Read** (`read-only`+): `get_server_info`, `list_schemas`, `list_tables`, `describe_table`, `select_rows`, `run_query`, `explain_query`, `list_active_queries`, `get_database_stats`, `get_top_queries`, `list_roles`, `list_extensions`

**Write** (`read-write`+): `insert_rows`, `update_rows`, `create_index`, `analyze_table`, `cancel_query`

**Admin** (`admin`): `delete_rows`, `drop_table`, `terminate_backend` (need `POSTGRES_ALLOW_DELETE`), `execute_sql` (only registered with `POSTGRES_ALLOW_RAW_SQL`)

## Recommended database role

The flags are defence in depth; the database's own privileges are the primary control. Give the server its own login role with only what it needs:

```sql
CREATE ROLE mcp_readonly LOGIN PASSWORD '…' CONNECTION LIMIT 5;
GRANT CONNECT ON DATABASE app TO mcp_readonly;
GRANT USAGE ON SCHEMA public TO mcp_readonly;
GRANT SELECT ON ALL TABLES IN SCHEMA public TO mcp_readonly;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT ON TABLES TO mcp_readonly;
GRANT pg_read_all_stats TO mcp_readonly;   -- optional: full query text in list_active_queries / get_top_queries
```

Grant `INSERT`/`UPDATE`/`DELETE` only on the tables a write task needs, and only for as long as it needs them.

## Quickstart — add to your agent

Published on npm as [`@dockndevai/mcp-postgres`](https://www.npmjs.com/package/@dockndevai/mcp-postgres). No clone or build needed — your MCP client runs it on demand with `npx`. **Start in `read-only` mode**; see [`.env.example`](.env.example) for every variable and [docs/CLIENTS.md](docs/CLIENTS.md) for the full per-client guide.

**Claude Code** (CLI)

```bash
claude mcp add postgres -e POSTGRES_URL="postgresql://mcp_readonly:PASSWORD@localhost:5432/app" -e POSTGRES_MODE="read-only" -- npx -y @dockndevai/mcp-postgres
```

**Claude Desktop · Cursor · Windsurf** — same block in `claude_desktop_config.json`, `.cursor/mcp.json`, or `~/.codeium/windsurf/mcp_config.json`:

```json
{
  "mcpServers": {
    "postgres": {
      "command": "npx",
      "args": [
        "-y",
        "@dockndevai/mcp-postgres"
      ],
      "env": {
        "POSTGRES_URL": "postgresql://mcp_readonly:PASSWORD@localhost:5432/app",
        "POSTGRES_MODE": "read-only"
      }
    }
  }
}
```

**OpenAI Codex CLI** — in `~/.codex/config.toml`:

```toml
[mcp_servers.postgres]
command = "npx"
args = ["-y", "@dockndevai/mcp-postgres"]
env = { POSTGRES_URL = "postgresql://mcp_readonly:PASSWORD@localhost:5432/app", POSTGRES_MODE = "read-only" }
```

**VS Code (GitHub Copilot, Agent mode)** — in `.vscode/mcp.json`:

```json
{
  "servers": {
    "postgres": {
      "type": "stdio",
      "command": "npx",
      "args": [
        "-y",
        "@dockndevai/mcp-postgres"
      ],
      "env": {
        "POSTGRES_URL": "postgresql://mcp_readonly:PASSWORD@localhost:5432/app",
        "POSTGRES_MODE": "read-only"
      }
    }
  }
}
```

## Example prompts

- *"Which tables in `public` are the largest, and which of their indexes are never scanned?"*
- *"Why is this query slow? Explain it and suggest an index."*
- *"What is running right now, and is anything waiting on a lock?"*
- *"Mark order 1042 as refunded."* (needs `read-write`)

## Run from source (development)

Prefer the published package above. To run from a clone:

```bash
npm install
npm run build
node dist/index.js   # with the environment variables set
```

## Develop

```bash
npm run dev
npm test
npm run typecheck
```

Integration tests run against a real database when `POSTGRES_TEST_ADMIN_URL` points at a disposable superuser connection (they create and drop the `mcp_it` schema and role):

```bash
POSTGRES_TEST_ADMIN_URL=postgresql://postgres:pw@127.0.0.1:5432/postgres npm test
```

## Publishing

This server ships a [`server.json`](server.json) for the official MCP registry and an [`mcpName`](package.json) for npm ownership validation. See **[PUBLISHING.md](PUBLISHING.md)** for publishing to npm and listing on the MCP registry, Smithery, Glama, Cursor, and PulseMCP.

## License

MIT
