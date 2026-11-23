# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.0] - 2026-11-23

### Added
- Initial release: a PostgreSQL MCP server on the suite's safe-by-default model.
- Read tools: `get_server_info`, `list_schemas`, `list_tables`, `describe_table`, `select_rows`, `run_query`,
  `explain_query`, `list_active_queries`, `get_database_stats`, `get_top_queries`, `list_roles`, `list_extensions`.
- Write tools: `insert_rows`, `update_rows`, `create_index`, `analyze_table`, `cancel_query`.
- Admin tools: `delete_rows`, `drop_table`, `terminate_backend` (need `POSTGRES_ALLOW_DELETE`), and `execute_sql`
  (only registered with `POSTGRES_ALLOW_RAW_SQL`).
- Reads run in a rolled-back `READ ONLY` transaction over the extended protocol; superuser connections are refused
  by default; schema allowlist / protected schemas; `POSTGRES_MAX_AFFECTED_ROWS` and `POSTGRES_MAX_ROWS` caps;
  secret-column and credential redaction.
- Human approvals bound to the exact tool + arguments and to the target's version (shared `elicit.ts` from
  `mcp-core` 0.2.x), `POSTGRES_REQUIRE_HUMAN_APPROVAL`, dry-run, JSON audit log, optional laya-guard.
