use std::fs;
use std::io::{self, Read};
use std::path::{Path, PathBuf};
use std::process::ExitCode;

use clap::{Parser, Subcommand};
use serde::{Deserialize, Serialize};

mod bundle_writer;
mod inspection;
mod rows;
mod schema;

use bundle_writer::*;
use inspection::*;

const PROTOCOL_VERSION: u32 = 1;
const BINARY_NAME: &str = "oah-archive-export";
const BINARY_VERSION: &str = env!("CARGO_PKG_VERSION");

#[derive(Parser)]
#[command(name = BINARY_NAME, version = BINARY_VERSION, about = "Open Agent Harness native archive export utilities.")]
struct Cli {
    #[command(subcommand)]
    command: Command,
}

#[derive(Subcommand)]
enum Command {
    Version,
    InspectExportRoot,
    WriteChecksum,
    WriteBundle,
    WriteBundleStream,
    ServeWriteBundleStream,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct VersionResponse<'a> {
    ok: bool,
    protocol_version: u32,
    name: &'a str,
    version: &'a str,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ErrorResponse {
    ok: bool,
    protocol_version: u32,
    code: &'static str,
    message: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct InspectExportRootRequest {
    export_root: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct InspectExportRootResponse {
    ok: bool,
    protocol_version: u32,
    unexpected_directories: Vec<String>,
    leftover_temp_files: Vec<String>,
    unexpected_files: Vec<String>,
    missing_checksums: Vec<String>,
    orphan_checksums: Vec<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct WriteChecksumRequest {
    file_path: String,
    output_path: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct WriteChecksumResponse {
    ok: bool,
    protocol_version: u32,
    file_path: String,
    output_path: String,
    checksum: String,
}

fn main() -> ExitCode {
    let cli = Cli::parse();
    match run(cli.command) {
        Ok(()) => ExitCode::SUCCESS,
        Err(error) => {
            let response = ErrorResponse {
                ok: false,
                protocol_version: PROTOCOL_VERSION,
                code: "archive_export_failed",
                message: error,
            };
            let _ = serde_json::to_writer(io::stderr(), &response);
            eprintln!();
            ExitCode::FAILURE
        }
    }
}

fn run(command: Command) -> Result<(), String> {
    match command {
        Command::Version => write_json(&VersionResponse {
            ok: true,
            protocol_version: PROTOCOL_VERSION,
            name: BINARY_NAME,
            version: BINARY_VERSION,
        }),
        Command::InspectExportRoot => {
            let request: InspectExportRootRequest = read_stdin_json()?;
            let inspection = inspect_export_root(Path::new(&request.export_root))?;
            write_json(&InspectExportRootResponse {
                ok: true,
                protocol_version: PROTOCOL_VERSION,
                unexpected_directories: inspection.unexpected_directories,
                leftover_temp_files: inspection.leftover_temp_files,
                unexpected_files: inspection.unexpected_files,
                missing_checksums: inspection.missing_checksums,
                orphan_checksums: inspection.orphan_checksums,
            })
        }
        Command::WriteChecksum => {
            let request: WriteChecksumRequest = read_stdin_json()?;
            let file_path = PathBuf::from(&request.file_path);
            let output_path = request
                .output_path
                .map(PathBuf::from)
                .unwrap_or_else(|| PathBuf::from(format!("{}.sha256", request.file_path)));
            let checksum = sha256_file(&file_path)?;
            let file_name = file_path
                .file_name()
                .and_then(|value| value.to_str())
                .ok_or_else(|| {
                    format!(
                        "Failed to derive archive file name from {}.",
                        file_path.display()
                    )
                })?;
            fs::write(&output_path, format!("{checksum}  {file_name}\n")).map_err(|error| {
                format!(
                    "Failed to write checksum file {}: {error}",
                    output_path.display()
                )
            })?;

            write_json(&WriteChecksumResponse {
                ok: true,
                protocol_version: PROTOCOL_VERSION,
                file_path: file_path.to_string_lossy().to_string(),
                output_path: output_path.to_string_lossy().to_string(),
                checksum,
            })
        }
        Command::WriteBundle => {
            let request: WriteBundleRequest = read_stdin_json()?;
            write_bundle(&request)?;
            write_json(&WriteBundleResponse {
                ok: true,
                protocol_version: PROTOCOL_VERSION,
                output_path: request.output_path,
                archive_date: request.archive_date,
                archive_count: request.archives.len(),
            })
        }
        Command::WriteBundleStream => {
            let response = write_bundle_stream()?;
            write_json(&response)
        }
        Command::ServeWriteBundleStream => serve_write_bundle_stream(),
    }
}

fn read_stdin_json<T: for<'de> Deserialize<'de>>() -> Result<T, String> {
    let mut input = String::new();
    io::stdin()
        .read_to_string(&mut input)
        .map_err(|error| format!("Failed to read stdin: {error}"))?;
    serde_json::from_str(&input).map_err(|error| format!("Failed to parse stdin JSON: {error}"))
}

fn write_json<T: Serialize>(value: &T) -> Result<(), String> {
    serde_json::to_writer(io::stdout(), value)
        .map_err(|error| format!("Failed to write stdout JSON: {error}"))?;
    println!();
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use rusqlite::Connection;
    use serde_json::{json, Value};
    use std::io::Cursor;
    use tempfile::tempdir;

    fn sample_archive() -> Value {
        json!({
            "id": "warc_1",
            "workspaceId": "ws_1",
            "scopeType": "workspace",
            "scopeId": "ws_1",
            "archiveDate": "2026-04-08",
            "archivedAt": "2026-04-08T12:00:00.000Z",
            "deletedAt": "2026-04-08T12:00:00.000Z",
            "timezone": "Asia/Shanghai",
            "workspace": {
                "id": "ws_1",
                "name": "demo",
                "rootPath": "/tmp/demo"
            },
            "sessions": [{
                "id": "ses_1",
                "workspaceId": "ws_1",
                "subjectRef": "dev:test",
                "activeAgentName": "builder",
                "status": "active",
                "createdAt": "2026-04-08T11:00:00.000Z",
                "updatedAt": "2026-04-08T12:00:00.000Z"
            }],
            "runs": [{
                "id": "run_1",
                "workspaceId": "ws_1",
                "sessionId": "ses_1",
                "triggerType": "message",
                "effectiveAgentName": "builder",
                "status": "completed",
                "createdAt": "2026-04-08T11:05:00.000Z"
            }],
            "messages": [{
                "id": "msg_1",
                "sessionId": "ses_1",
                "runId": "run_1",
                "role": "assistant",
                "content": "hello",
                "createdAt": "2026-04-08T11:06:00.000Z"
            }],
            "engineMessages": [{
                "id": "emsg_1",
                "sessionId": "ses_1",
                "runId": "run_1",
                "role": "assistant",
                "kind": "assistant_text",
                "content": "runtime hello",
                "createdAt": "2026-04-08T11:06:01.000Z"
            }],
            "runSteps": [{
                "id": "step_1",
                "runId": "run_1",
                "seq": 1,
                "stepType": "model",
                "status": "completed",
                "createdAt": "ignored",
                "input": null
            }],
            "toolCalls": [{
                "id": "tool_1",
                "runId": "run_1",
                "sourceType": "engine",
                "toolName": "read_file",
                "status": "completed",
                "startedAt": "2026-04-08T11:07:00.000Z",
                "endedAt": "2026-04-08T11:07:01.000Z"
            }],
            "hookRuns": [{
                "id": "hook_1",
                "runId": "run_1",
                "hookName": "post-run",
                "eventName": "run.completed",
                "status": "completed",
                "startedAt": "2026-04-08T11:08:00.000Z",
                "endedAt": "2026-04-08T11:08:01.000Z",
                "capabilities": ["patch"]
            }],
            "artifacts": [{
                "id": "artifact_1",
                "runId": "run_1",
                "type": "file",
                "createdAt": "2026-04-08T11:09:00.000Z"
            }]
        })
    }

    fn assert_expected_bundle_rows(output_path: &Path) {
        let connection = Connection::open(output_path).expect("open written sqlite");
        let archive_count: i64 = connection
            .query_row(
                "select archive_count from archive_manifest where archive_date = ?",
                ["2026-04-08"],
                |row| row.get(0),
            )
            .expect("manifest row");
        let message_content: String = connection
            .query_row(
                "select content from messages where id = ?",
                ["msg_1"],
                |row| row.get(0),
            )
            .expect("message row");
        let runtime_message_count: i64 = connection
            .query_row("select count(*) from runtime_messages", [], |row| {
                row.get(0)
            })
            .expect("runtime message count");
        let artifact_count: i64 = connection
            .query_row("select count(*) from artifacts", [], |row| row.get(0))
            .expect("artifact count");

        assert_eq!(archive_count, 1);
        assert_eq!(message_content, "\"hello\"");
        assert_eq!(runtime_message_count, 1);
        assert_eq!(artifact_count, 1);
    }

    fn append_archive_rows_to_stream(stream: &mut String, archive: &Value) {
        stream.push_str(&format!(
            "{}\n",
            json!({ "type": "archive", "archive": archive })
        ));
        stream.push_str(&format!(
            "{}\n",
            json!({
                "type": "session",
                "archiveId": "warc_1",
                "row": archive.get("sessions").and_then(Value::as_array).and_then(|rows| rows.first()).cloned().expect("session")
            })
        ));
        stream.push_str(&format!(
            "{}\n",
            json!({
                "type": "run",
                "archiveId": "warc_1",
                "row": archive.get("runs").and_then(Value::as_array).and_then(|rows| rows.first()).cloned().expect("run")
            })
        ));
        stream.push_str(&format!(
            "{}\n",
            json!({
                "type": "message",
                "archiveId": "warc_1",
                "row": archive.get("messages").and_then(Value::as_array).and_then(|rows| rows.first()).cloned().expect("message")
            })
        ));
        stream.push_str(&format!(
            "{}\n",
            json!({
                "type": "engine_message",
                "archiveId": "warc_1",
                "row": archive.get("engineMessages").and_then(Value::as_array).and_then(|rows| rows.first()).cloned().expect("engine message")
            })
        ));
        stream.push_str(&format!(
            "{}\n",
            json!({
                "type": "run_step",
                "archiveId": "warc_1",
                "row": archive.get("runSteps").and_then(Value::as_array).and_then(|rows| rows.first()).cloned().expect("run step")
            })
        ));
        stream.push_str(&format!(
            "{}\n",
            json!({
                "type": "tool_call",
                "archiveId": "warc_1",
                "row": archive.get("toolCalls").and_then(Value::as_array).and_then(|rows| rows.first()).cloned().expect("tool call")
            })
        ));
        stream.push_str(&format!(
            "{}\n",
            json!({
                "type": "hook_run",
                "archiveId": "warc_1",
                "row": archive.get("hookRuns").and_then(Value::as_array).and_then(|rows| rows.first()).cloned().expect("hook run")
            })
        ));
        stream.push_str(&format!(
            "{}\n",
            json!({
                "type": "artifact",
                "archiveId": "warc_1",
                "row": archive.get("artifacts").and_then(Value::as_array).and_then(|rows| rows.first()).cloned().expect("artifact")
            })
        ));
    }

    #[test]
    fn write_bundle_persists_expected_rows() {
        let temp = tempdir().expect("tempdir");
        let output_path = temp.path().join("2026-04-08.sqlite");
        let request = WriteBundleRequest {
            output_path: output_path.to_string_lossy().to_string(),
            archive_date: "2026-04-08".to_string(),
            export_path: "/exports/2026-04-08.sqlite".to_string(),
            exported_at: "2026-04-09T00:00:00.000Z".to_string(),
            archives: vec![sample_archive()],
        };

        write_bundle(&request).expect("write bundle");
        assert_expected_bundle_rows(&output_path);
    }

    #[test]
    fn write_bundle_stream_persists_expected_rows() {
        let temp = tempdir().expect("tempdir");
        let output_path = temp.path().join("2026-04-08-stream.sqlite");
        let archive = sample_archive();
        let mut stream = String::new();
        stream.push_str(&format!(
            "{}\n",
            json!({
                "type": "header",
                "outputPath": output_path.to_string_lossy(),
                "archiveDate": "2026-04-08",
                "exportPath": "/exports/2026-04-08-stream.sqlite",
                "exportedAt": "2026-04-09T00:00:00.000Z"
            })
        ));
        append_archive_rows_to_stream(&mut stream, &archive);

        let response =
            write_bundle_stream_from_reader(Cursor::new(stream)).expect("write bundle stream");
        assert_eq!(response.archive_count, 1);
        assert_expected_bundle_rows(&output_path);
    }

    #[test]
    fn serve_write_bundle_stream_processes_request_and_replies() {
        let temp = tempdir().expect("tempdir");
        let output_path = temp.path().join("2026-04-08-worker.sqlite");
        let archive = sample_archive();
        let mut input = String::new();
        input.push_str(&format!(
            "{}\n",
            json!({
                "type": "request_start",
                "requestId": "req_1",
                "outputPath": output_path.to_string_lossy(),
                "archiveDate": "2026-04-08",
                "exportPath": "/exports/2026-04-08-worker.sqlite",
                "exportedAt": "2026-04-09T00:00:00.000Z"
            })
        ));
        append_archive_rows_to_stream(&mut input, &archive);
        input.push_str(&format!(
            "{}\n",
            json!({ "type": "request_end", "requestId": "req_1" })
        ));

        let mut output = Vec::new();
        serve_write_bundle_stream_from_reader(Cursor::new(input), &mut output)
            .expect("serve worker request");

        let response: Value = serde_json::from_slice(&output).expect("parse worker response");
        assert_eq!(response.get("ok"), Some(&Value::Bool(true)));
        assert_eq!(
            response.get("requestId"),
            Some(&Value::String("req_1".to_string()))
        );
        assert_eq!(response.get("archiveCount"), Some(&Value::Number(1.into())));
        assert_expected_bundle_rows(&output_path);
    }

    #[test]
    fn write_bundle_stream_record_parser_accepts_engine_message() {
        let record = parse_write_bundle_stream_record(
            r#"{"type":"engine_message","archiveId":"warc_1","row":{"id":"emsg_1"}}"#,
            2,
        )
        .expect("parse stream record");

        match record {
            WriteBundleStreamRecord::EngineMessage { archive_id, row } => {
                assert_eq!(archive_id, "warc_1");
                assert_eq!(row.get("id"), Some(&Value::String("emsg_1".to_string())));
            }
            _ => panic!("expected engine message record"),
        }
    }

    #[test]
    fn inspect_export_root_reports_expected_issues() {
        let temp = tempdir().expect("tempdir");
        fs::create_dir_all(temp.path().join("manual")).expect("manual dir");
        fs::write(temp.path().join("2026-04-08.sqlite"), "bundle").expect("bundle");
        fs::write(temp.path().join("2026-04-08.sqlite.tmp"), "temp").expect("temp");
        fs::write(temp.path().join("2026-04-09.sqlite.sha256"), "deadbeef").expect("checksum");
        fs::write(temp.path().join("notes.txt"), "note").expect("note");

        let inspection = inspect_export_root(temp.path()).expect("inspect");
        assert_eq!(inspection.unexpected_directories, vec!["manual"]);
        assert_eq!(
            inspection.leftover_temp_files,
            vec!["2026-04-08.sqlite.tmp"]
        );
        assert_eq!(inspection.unexpected_files, vec!["notes.txt"]);
        assert_eq!(inspection.missing_checksums, vec!["2026-04-08.sqlite"]);
        assert_eq!(
            inspection.orphan_checksums,
            vec!["2026-04-09.sqlite.sha256"]
        );
    }
}
