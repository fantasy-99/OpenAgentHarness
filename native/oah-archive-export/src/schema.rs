use rusqlite::Connection;

const ARCHIVE_SCHEMA_STATEMENTS: [&str; 10] = [
    r#"create table if not exists archive_manifest (
    archive_date text primary key,
    timezone text not null,
    exported_at text not null,
    archive_count integer not null
  )"#,
    r#"create table if not exists archives (
    archive_id text primary key,
    workspace_id text not null,
    scope_type text not null,
    scope_id text not null,
    archive_date text not null,
    archived_at text not null,
    deleted_at text not null,
    timezone text not null,
    exported_at text,
    export_path text,
    workspace_name text not null,
    root_path text not null,
    workspace_snapshot text not null
  )"#,
    r#"create table if not exists sessions (
    archive_id text not null,
    id text not null,
    workspace_id text not null,
    subject_ref text not null,
    model_ref text,
    agent_name text,
    active_agent_name text not null,
    title text,
    status text not null,
    last_run_at text,
    created_at text not null,
    updated_at text not null,
    payload text not null,
    primary key (archive_id, id)
  )"#,
    r#"create table if not exists runs (
    archive_id text not null,
    id text not null,
    workspace_id text not null,
    session_id text,
    parent_run_id text,
    trigger_type text not null,
    trigger_ref text,
    agent_name text,
    effective_agent_name text not null,
    status text not null,
    created_at text not null,
    started_at text,
    heartbeat_at text,
    ended_at text,
    payload text not null,
    primary key (archive_id, id)
  )"#,
    r#"create table if not exists messages (
    archive_id text not null,
    id text not null,
    session_id text not null,
    run_id text,
    role text not null,
    created_at text not null,
    content text not null,
    metadata text,
    primary key (archive_id, id)
  )"#,
    r#"create table if not exists runtime_messages (
    archive_id text not null,
    id text not null,
    session_id text not null,
    run_id text,
    role text not null,
    kind text not null,
    created_at text not null,
    content text not null,
    metadata text,
    primary key (archive_id, id)
  )"#,
    r#"create table if not exists run_steps (
    archive_id text not null,
    id text not null,
    run_id text not null,
    seq integer not null,
    step_type text not null,
    name text,
    agent_name text,
    status text not null,
    started_at text,
    ended_at text,
    input text,
    output text,
    primary key (archive_id, id)
  )"#,
    r#"create table if not exists tool_calls (
    archive_id text not null,
    id text not null,
    run_id text not null,
    step_id text,
    source_type text not null,
    tool_name text not null,
    status text not null,
    duration_ms integer,
    started_at text not null,
    ended_at text not null,
    request text,
    response text,
    primary key (archive_id, id)
  )"#,
    r#"create table if not exists hook_runs (
    archive_id text not null,
    id text not null,
    run_id text not null,
    hook_name text not null,
    event_name text not null,
    status text not null,
    started_at text not null,
    ended_at text not null,
    capabilities text not null,
    patch text,
    error_message text,
    primary key (archive_id, id)
  )"#,
    r#"create table if not exists artifacts (
    archive_id text not null,
    id text not null,
    run_id text not null,
    type text not null,
    path text,
    content_ref text,
    created_at text not null,
    metadata text,
    primary key (archive_id, id)
  )"#,
];

pub(crate) fn apply_archive_schema(connection: &Connection) -> Result<(), String> {
    for statement in ARCHIVE_SCHEMA_STATEMENTS {
        connection
            .execute(statement, [])
            .map_err(|error| format!("Failed to apply archive sqlite schema: {error}"))?;
    }
    Ok(())
}

pub(crate) const INSERT_ARCHIVE_MANIFEST_SQL: &str =
    "insert or replace into archive_manifest (archive_date, timezone, exported_at, archive_count) values (?, ?, ?, ?)";
pub(crate) const INSERT_ARCHIVE_SQL: &str = r#"insert or replace into archives (
                archive_id, workspace_id, scope_type, scope_id, archive_date, archived_at, deleted_at, timezone, exported_at, export_path, workspace_name, root_path, workspace_snapshot
              ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"#;
pub(crate) const INSERT_SESSION_SQL: &str = r#"insert or replace into sessions (
                    archive_id, id, workspace_id, subject_ref, model_ref, agent_name, active_agent_name, title, status, last_run_at, created_at, updated_at, payload
                  ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"#;
pub(crate) const INSERT_RUN_SQL: &str = r#"insert or replace into runs (
                    archive_id, id, workspace_id, session_id, parent_run_id, trigger_type, trigger_ref, agent_name, effective_agent_name, status, created_at, started_at, heartbeat_at, ended_at, payload
                  ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"#;
pub(crate) const INSERT_MESSAGE_SQL: &str = r#"insert or replace into messages (
                    archive_id, id, session_id, run_id, role, created_at, content, metadata
                  ) values (?, ?, ?, ?, ?, ?, ?, ?)"#;
pub(crate) const INSERT_RUNTIME_MESSAGE_SQL: &str = r#"insert or replace into runtime_messages (
                    archive_id, id, session_id, run_id, role, kind, created_at, content, metadata
                  ) values (?, ?, ?, ?, ?, ?, ?, ?, ?)"#;
pub(crate) const INSERT_RUN_STEP_SQL: &str = r#"insert or replace into run_steps (
                    archive_id, id, run_id, seq, step_type, name, agent_name, status, started_at, ended_at, input, output
                  ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"#;
pub(crate) const INSERT_TOOL_CALL_SQL: &str = r#"insert or replace into tool_calls (
                    archive_id, id, run_id, step_id, source_type, tool_name, status, duration_ms, started_at, ended_at, request, response
                  ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"#;
pub(crate) const INSERT_HOOK_RUN_SQL: &str = r#"insert or replace into hook_runs (
                    archive_id, id, run_id, hook_name, event_name, status, started_at, ended_at, capabilities, patch, error_message
                  ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"#;
pub(crate) const INSERT_ARTIFACT_SQL: &str = r#"insert or replace into artifacts (
                    archive_id, id, run_id, type, path, content_ref, created_at, metadata
                  ) values (?, ?, ?, ?, ?, ?, ?, ?)"#;
