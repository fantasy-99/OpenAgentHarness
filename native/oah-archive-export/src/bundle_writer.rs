use std::fs;
use std::io::{self, BufRead, Write};
use std::path::PathBuf;

use rusqlite::Connection;
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::rows::*;
use crate::schema::*;
use crate::PROTOCOL_VERSION;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct WriteBundleRequest {
    pub(crate) output_path: String,
    pub(crate) archive_date: String,
    pub(crate) export_path: String,
    pub(crate) exported_at: String,
    pub(crate) archives: Vec<Value>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct WriteBundleStreamHeader {
    output_path: String,
    archive_date: String,
    export_path: String,
    exported_at: String,
}

#[derive(Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub(crate) enum WriteBundleStreamRecord {
    Header {
        #[serde(rename = "outputPath")]
        output_path: String,
        #[serde(rename = "archiveDate")]
        archive_date: String,
        #[serde(rename = "exportPath")]
        export_path: String,
        #[serde(rename = "exportedAt")]
        exported_at: String,
    },
    Archive {
        archive: Value,
    },
    Session {
        #[serde(rename = "archiveId")]
        archive_id: String,
        row: Value,
    },
    Run {
        #[serde(rename = "archiveId")]
        archive_id: String,
        row: Value,
    },
    Message {
        #[serde(rename = "archiveId")]
        archive_id: String,
        row: Value,
    },
    EngineMessage {
        #[serde(rename = "archiveId")]
        archive_id: String,
        row: Value,
    },
    RunStep {
        #[serde(rename = "archiveId")]
        archive_id: String,
        row: Value,
    },
    ToolCall {
        #[serde(rename = "archiveId")]
        archive_id: String,
        row: Value,
    },
    HookRun {
        #[serde(rename = "archiveId")]
        archive_id: String,
        row: Value,
    },
    Artifact {
        #[serde(rename = "archiveId")]
        archive_id: String,
        row: Value,
    },
}

#[derive(Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
enum ServeWriteBundleStreamRecord {
    RequestStart {
        #[serde(rename = "requestId")]
        request_id: String,
        #[serde(rename = "outputPath")]
        output_path: String,
        #[serde(rename = "archiveDate")]
        archive_date: String,
        #[serde(rename = "exportPath")]
        export_path: String,
        #[serde(rename = "exportedAt")]
        exported_at: String,
    },
    RequestEnd {
        #[serde(rename = "requestId")]
        request_id: String,
    },
    Archive {
        archive: Value,
    },
    Session {
        #[serde(rename = "archiveId")]
        archive_id: String,
        row: Value,
    },
    Run {
        #[serde(rename = "archiveId")]
        archive_id: String,
        row: Value,
    },
    Message {
        #[serde(rename = "archiveId")]
        archive_id: String,
        row: Value,
    },
    EngineMessage {
        #[serde(rename = "archiveId")]
        archive_id: String,
        row: Value,
    },
    RunStep {
        #[serde(rename = "archiveId")]
        archive_id: String,
        row: Value,
    },
    ToolCall {
        #[serde(rename = "archiveId")]
        archive_id: String,
        row: Value,
    },
    HookRun {
        #[serde(rename = "archiveId")]
        archive_id: String,
        row: Value,
    },
    Artifact {
        #[serde(rename = "archiveId")]
        archive_id: String,
        row: Value,
    },
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct WriteBundleResponse {
    pub(crate) ok: bool,
    pub(crate) protocol_version: u32,
    pub(crate) output_path: String,
    pub(crate) archive_date: String,
    pub(crate) archive_count: usize,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ServeWriteBundleStreamResponse {
    ok: bool,
    protocol_version: u32,
    request_id: String,
    output_path: Option<String>,
    archive_date: Option<String>,
    archive_count: Option<usize>,
    code: Option<String>,
    message: Option<String>,
}

struct ActiveServeWriteBundleRequest {
    request_id: String,
    output_path: String,
    archive_date: String,
    export_path: String,
    exported_at: String,
    connection: Connection,
    archive_count: usize,
    timezone: Option<String>,
    failed: Option<(String, String)>,
}

pub(crate) fn write_bundle(request: &WriteBundleRequest) -> Result<(), String> {
    let output_path = PathBuf::from(&request.output_path);
    if let Some(parent) = output_path.parent() {
        fs::create_dir_all(parent).map_err(|error| {
            format!(
                "Failed to create archive export directory {}: {error}",
                parent.display()
            )
        })?;
    }

    match fs::remove_file(&output_path) {
        Ok(()) => {}
        Err(error) if error.kind() == io::ErrorKind::NotFound => {}
        Err(error) => {
            return Err(format!(
                "Failed to clear previous archive bundle {}: {error}",
                output_path.display()
            ))
        }
    }

    let mut connection = Connection::open(&output_path).map_err(|error| {
        format!(
            "Failed to open archive sqlite bundle {}: {error}",
            output_path.display()
        )
    })?;
    apply_archive_write_pragmas(&connection)?;
    apply_archive_schema(&connection)?;

    let transaction = connection
        .transaction()
        .map_err(|error| format!("Failed to open archive sqlite transaction: {error}"))?;
    insert_archive_rows(
        &transaction,
        &request.archive_date,
        &request.export_path,
        &request.exported_at,
        &request.archives,
    )?;
    transaction
        .commit()
        .map_err(|error| format!("Failed to commit archive sqlite transaction: {error}"))?;

    Ok(())
}

pub(crate) fn write_bundle_stream() -> Result<WriteBundleResponse, String> {
    let stdin = io::stdin();
    write_bundle_stream_from_reader(stdin.lock())
}

pub(crate) fn serve_write_bundle_stream() -> Result<(), String> {
    let stdin = io::stdin();
    let stdout = io::stdout();
    serve_write_bundle_stream_from_reader(stdin.lock(), stdout.lock())
}

pub(crate) fn serve_write_bundle_stream_from_reader<R: BufRead, W: Write>(
    reader: R,
    mut writer: W,
) -> Result<(), String> {
    let mut current_request: Option<ActiveServeWriteBundleRequest> = None;

    for (index, line_result) in reader.lines().enumerate() {
        let line = line_result
            .map_err(|error| format!("Failed to read stdin line {}: {error}", index + 1))?;
        if line.trim().is_empty() {
            continue;
        }

        let record: ServeWriteBundleStreamRecord =
            serde_json::from_str(&line).map_err(|error| {
                format!(
                    "Failed to parse archive export worker record on line {}: {error}",
                    index + 1
                )
            })?;

        match record {
            ServeWriteBundleStreamRecord::RequestStart {
                request_id,
                output_path,
                archive_date,
                export_path,
                exported_at,
            } => {
                if current_request.is_some() {
                    return Err(format!(
                        "Received request_start for {request_id} while another archive export request is still active."
                    ));
                }

                let connection = open_archive_bundle_connection(&output_path)?;
                connection
                    .execute_batch("begin immediate")
                    .map_err(|error| {
                        format!(
                            "Failed to begin archive sqlite transaction for {request_id}: {error}"
                        )
                    })?;

                current_request = Some(ActiveServeWriteBundleRequest {
                    request_id,
                    output_path,
                    archive_date,
                    export_path,
                    exported_at,
                    connection,
                    archive_count: 0,
                    timezone: None,
                    failed: None,
                });
            }
            ServeWriteBundleStreamRecord::RequestEnd { request_id } => {
                let mut request = current_request
                    .take()
                    .ok_or_else(|| format!("Received request_end for {request_id} without an active archive export request."))?;
                if request.request_id != request_id {
                    return Err(format!(
                        "Received request_end for {request_id}, but the active archive export request is {}.",
                        request.request_id
                    ));
                }

                let response = match request.failed.take() {
                    Some((code, message)) => {
                        let _ = request.connection.execute_batch("rollback");
                        ServeWriteBundleStreamResponse {
                            ok: false,
                            protocol_version: PROTOCOL_VERSION,
                            request_id,
                            output_path: Some(request.output_path),
                            archive_date: Some(request.archive_date),
                            archive_count: Some(request.archive_count),
                            code: Some(code),
                            message: Some(message),
                        }
                    }
                    None => {
                        insert_archive_manifest_row(
                            &request.connection,
                            &request.archive_date,
                            request.timezone.as_deref().unwrap_or("UTC"),
                            &request.exported_at,
                            request.archive_count,
                        )?;
                        request
                            .connection
                            .execute_batch("commit")
                            .map_err(|error| {
                                format!(
                                    "Failed to commit archive sqlite transaction for {}: {error}",
                                    request.request_id
                                )
                            })?;
                        ServeWriteBundleStreamResponse {
                            ok: true,
                            protocol_version: PROTOCOL_VERSION,
                            request_id,
                            output_path: Some(request.output_path),
                            archive_date: Some(request.archive_date),
                            archive_count: Some(request.archive_count),
                            code: None,
                            message: None,
                        }
                    }
                };

                serde_json::to_writer(&mut writer, &response).map_err(|error| {
                    format!("Failed to write archive export worker response: {error}")
                })?;
                writeln!(&mut writer).map_err(|error| {
                    format!("Failed to write archive export worker newline: {error}")
                })?;
                writer.flush().map_err(|error| {
                    format!("Failed to flush archive export worker response: {error}")
                })?;
            }
            other => {
                let request = current_request.as_mut().ok_or_else(|| {
                    "Received archive export row data without an active request.".to_string()
                })?;
                if request.failed.is_some() {
                    continue;
                }

                if let Err(error) = apply_serve_write_bundle_record(request, other) {
                    let _ = request.connection.execute_batch("rollback");
                    request.failed = Some(("archive_export_request_failed".to_string(), error));
                }
            }
        }
    }

    if let Some(request) = current_request {
        return Err(format!(
            "Archive export worker reached EOF while request {} was still active.",
            request.request_id
        ));
    }

    Ok(())
}

pub(crate) fn write_bundle_stream_from_reader<R: BufRead>(
    reader: R,
) -> Result<WriteBundleResponse, String> {
    let mut lines = reader.lines();

    let header = match lines.next() {
        None => return Err("Missing archive export stream header.".to_string()),
        Some(line) => parse_write_bundle_stream_header(
            &line.map_err(|error| format!("Failed to read stdin: {error}"))?,
        )?,
    };

    let output_path = PathBuf::from(&header.output_path);
    if let Some(parent) = output_path.parent() {
        fs::create_dir_all(parent).map_err(|error| {
            format!(
                "Failed to create archive export directory {}: {error}",
                parent.display()
            )
        })?;
    }

    match fs::remove_file(&output_path) {
        Ok(()) => {}
        Err(error) if error.kind() == io::ErrorKind::NotFound => {}
        Err(error) => {
            return Err(format!(
                "Failed to clear previous archive bundle {}: {error}",
                output_path.display()
            ))
        }
    }

    let mut connection = Connection::open(&output_path).map_err(|error| {
        format!(
            "Failed to open archive sqlite bundle {}: {error}",
            output_path.display()
        )
    })?;
    apply_archive_write_pragmas(&connection)?;
    apply_archive_schema(&connection)?;

    let transaction = connection
        .transaction()
        .map_err(|error| format!("Failed to open archive sqlite transaction: {error}"))?;

    let mut archive_count = 0usize;
    let mut timezone: Option<String> = None;

    for (index, line_result) in lines.enumerate() {
        let line = line_result
            .map_err(|error| format!("Failed to read stdin line {}: {error}", index + 2))?;
        if line.trim().is_empty() {
            continue;
        }

        match parse_write_bundle_stream_record(&line, index + 2)? {
            WriteBundleStreamRecord::Header { .. } => {
                return Err(format!(
                    "Unexpected stream header record at line {}.",
                    index + 2
                ));
            }
            WriteBundleStreamRecord::Archive { archive } => {
                if timezone.is_none() {
                    timezone = optional_str_field(&archive, "timezone")?;
                }
                insert_archive_row(
                    &transaction,
                    &header.archive_date,
                    &header.export_path,
                    &header.exported_at,
                    &archive,
                )?;
                archive_count += 1;
            }
            WriteBundleStreamRecord::Session { archive_id, row } => {
                insert_session_row(&transaction, &archive_id, &row)?;
            }
            WriteBundleStreamRecord::Run { archive_id, row } => {
                insert_run_row(&transaction, &archive_id, &row)?;
            }
            WriteBundleStreamRecord::Message { archive_id, row } => {
                insert_message_row(&transaction, &archive_id, &row)?;
            }
            WriteBundleStreamRecord::EngineMessage { archive_id, row } => {
                insert_runtime_message_row(&transaction, &archive_id, &row)?;
            }
            WriteBundleStreamRecord::RunStep { archive_id, row } => {
                insert_run_step_row(&transaction, &archive_id, &row)?;
            }
            WriteBundleStreamRecord::ToolCall { archive_id, row } => {
                insert_tool_call_row(&transaction, &archive_id, &row)?;
            }
            WriteBundleStreamRecord::HookRun { archive_id, row } => {
                insert_hook_run_row(&transaction, &archive_id, &row)?;
            }
            WriteBundleStreamRecord::Artifact { archive_id, row } => {
                insert_artifact_row(&transaction, &archive_id, &row)?;
            }
        }
    }

    insert_archive_manifest_row(
        &transaction,
        &header.archive_date,
        timezone.as_deref().unwrap_or("UTC"),
        &header.exported_at,
        archive_count,
    )?;
    transaction
        .commit()
        .map_err(|error| format!("Failed to commit archive sqlite transaction: {error}"))?;

    Ok(WriteBundleResponse {
        ok: true,
        protocol_version: PROTOCOL_VERSION,
        output_path: header.output_path,
        archive_date: header.archive_date,
        archive_count,
    })
}

fn open_archive_bundle_connection(output_path: &str) -> Result<Connection, String> {
    let output_path = PathBuf::from(output_path);
    if let Some(parent) = output_path.parent() {
        fs::create_dir_all(parent).map_err(|error| {
            format!(
                "Failed to create archive export directory {}: {error}",
                parent.display()
            )
        })?;
    }

    match fs::remove_file(&output_path) {
        Ok(()) => {}
        Err(error) if error.kind() == io::ErrorKind::NotFound => {}
        Err(error) => {
            return Err(format!(
                "Failed to clear previous archive bundle {}: {error}",
                output_path.display()
            ))
        }
    }

    let connection = Connection::open(&output_path).map_err(|error| {
        format!(
            "Failed to open archive sqlite bundle {}: {error}",
            output_path.display()
        )
    })?;
    connection.set_prepared_statement_cache_capacity(16);
    apply_archive_write_pragmas(&connection)?;
    apply_archive_schema(&connection)?;
    Ok(connection)
}

fn apply_serve_write_bundle_record(
    request: &mut ActiveServeWriteBundleRequest,
    record: ServeWriteBundleStreamRecord,
) -> Result<(), String> {
    match record {
        ServeWriteBundleStreamRecord::RequestStart { .. }
        | ServeWriteBundleStreamRecord::RequestEnd { .. } => Err(
            "Received worker request boundary inside active archive export request.".to_string(),
        ),
        ServeWriteBundleStreamRecord::Archive { archive } => {
            if request.timezone.is_none() {
                request.timezone = optional_str_field(&archive, "timezone")?;
            }
            insert_archive_row(
                &request.connection,
                &request.archive_date,
                &request.export_path,
                &request.exported_at,
                &archive,
            )?;
            request.archive_count += 1;
            Ok(())
        }
        ServeWriteBundleStreamRecord::Session { archive_id, row } => {
            insert_session_row(&request.connection, &archive_id, &row)
        }
        ServeWriteBundleStreamRecord::Run { archive_id, row } => {
            insert_run_row(&request.connection, &archive_id, &row)
        }
        ServeWriteBundleStreamRecord::Message { archive_id, row } => {
            insert_message_row(&request.connection, &archive_id, &row)
        }
        ServeWriteBundleStreamRecord::EngineMessage { archive_id, row } => {
            insert_runtime_message_row(&request.connection, &archive_id, &row)
        }
        ServeWriteBundleStreamRecord::RunStep { archive_id, row } => {
            insert_run_step_row(&request.connection, &archive_id, &row)
        }
        ServeWriteBundleStreamRecord::ToolCall { archive_id, row } => {
            insert_tool_call_row(&request.connection, &archive_id, &row)
        }
        ServeWriteBundleStreamRecord::HookRun { archive_id, row } => {
            insert_hook_run_row(&request.connection, &archive_id, &row)
        }
        ServeWriteBundleStreamRecord::Artifact { archive_id, row } => {
            insert_artifact_row(&request.connection, &archive_id, &row)
        }
    }
}

fn parse_write_bundle_stream_header(line: &str) -> Result<WriteBundleStreamHeader, String> {
    match parse_write_bundle_stream_record(line, 1)? {
        WriteBundleStreamRecord::Header {
            output_path,
            archive_date,
            export_path,
            exported_at,
        } => Ok(WriteBundleStreamHeader {
            output_path,
            archive_date,
            export_path,
            exported_at,
        }),
        _ => Err("Archive export stream must start with a header record.".to_string()),
    }
}

pub(crate) fn parse_write_bundle_stream_record(
    line: &str,
    line_number: usize,
) -> Result<WriteBundleStreamRecord, String> {
    serde_json::from_str(line).map_err(|error| {
        format!("Failed to parse archive export stream record on line {line_number}: {error}")
    })
}
