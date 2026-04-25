use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet};
use std::fs;
use std::future::Future;
use std::io::{self, BufRead, BufReader, BufWriter, Read, Write};
use std::path::{Path, PathBuf};
use std::process::ExitCode;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Instant, SystemTime, UNIX_EPOCH};

use aws_credential_types::Credentials;
use aws_sdk_s3::config::Region;
use aws_sdk_s3::error::ProvideErrorMetadata;
use aws_sdk_s3::primitives::ByteStream;
use aws_sdk_s3::types::{Delete, ObjectIdentifier};
use aws_sdk_s3::Client as S3Client;
use clap::{Parser, Subcommand};
use filetime::{set_file_mtime, FileTime};
use serde::de::DeserializeOwned;
use serde::Deserialize;
use serde::Serialize;
use serde_json::Value;
use sha1::{Digest, Sha1};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::runtime::Builder as RuntimeBuilder;
use tokio::task::JoinSet;

mod local_fs;
mod path_rules;
mod sandbox_http;
mod sync_bundle;

use local_fs::*;
use path_rules::*;
use sandbox_http::*;
use sync_bundle::*;

const PROTOCOL_VERSION: u32 = 1;
const BINARY_NAME: &str = "oah-workspace-sync";
const BINARY_VERSION: &str = env!("CARGO_PKG_VERSION");
const OBJECT_MTIME_METADATA_KEY: &str = "oah-mtime-ms";
const INLINE_UPLOAD_THRESHOLD_BYTES: u64 = 128 * 1024;
const DEFAULT_SYNC_BUNDLE_MIN_FILE_COUNT: usize = 16;
const DEFAULT_SYNC_BUNDLE_MIN_TOTAL_BYTES: u64 = 128 * 1024;

#[derive(Parser)]
#[command(name = BINARY_NAME, version = BINARY_VERSION, about = "Open Agent Harness native workspace sync utilities.")]
struct Cli {
    #[command(subcommand)]
    command: Command,
}

#[derive(Subcommand)]
enum Command {
    Ready,
    Version,
    Serve,
    Fingerprint,
    FingerprintBatch,
    ScanLocalTree,
    PlanLocalToRemote,
    SyncLocalToRemote,
    PlanRemoteToLocal,
    SyncRemoteToLocal,
    PlanSeedUpload,
    BuildSeedArchive,
    SyncLocalToSandboxHttp,
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
struct ReadyResponse {
    ok: bool,
    protocol_version: u32,
}

#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct FingerprintRequest {
    root_dir: String,
    #[serde(default)]
    exclude_relative_paths: Vec<String>,
}

#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct FingerprintBatchRequest {
    directories: Vec<FingerprintRequest>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct FingerprintResponse {
    ok: bool,
    protocol_version: u32,
    fingerprint: String,
    file_count: usize,
    empty_directory_count: usize,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct FingerprintBatchResponse {
    ok: bool,
    protocol_version: u32,
    results: Vec<FingerprintBatchEntry>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct FingerprintBatchEntry {
    root_dir: String,
    fingerprint: String,
    file_count: usize,
    empty_directory_count: usize,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SyncLocalToRemoteRequest {
    root_dir: String,
    remote_prefix: String,
    #[serde(default)]
    exclude_relative_paths: Vec<String>,
    #[serde(default)]
    max_concurrency: Option<usize>,
    #[serde(default)]
    inline_upload_threshold_bytes: Option<u64>,
    #[serde(default)]
    sync_bundle: Option<NativeSyncBundleConfig>,
    object_store: NativeObjectStoreConfig,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SyncRemoteToLocalRequest {
    root_dir: String,
    remote_prefix: String,
    #[serde(default)]
    exclude_relative_paths: Vec<String>,
    #[serde(default)]
    preserve_top_level_names: Vec<String>,
    #[serde(default)]
    max_concurrency: Option<usize>,
    #[serde(default)]
    remote_entries: Option<Vec<PlanRemoteEntry>>,
    #[serde(default)]
    has_sync_manifest: Option<bool>,
    #[serde(default)]
    bundle_entry: Option<PlanRemoteEntry>,
    #[serde(default)]
    sync_bundle: Option<NativeSyncBundleConfig>,
    object_store: NativeObjectStoreConfig,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SyncLocalToSandboxHttpRequest {
    root_dir: String,
    remote_root_path: String,
    #[serde(default)]
    exclude_relative_paths: Vec<String>,
    #[serde(default)]
    max_concurrency: Option<usize>,
    sandbox: NativeSandboxHttpConfig,
}

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct NativeObjectStoreConfig {
    bucket: String,
    region: String,
    endpoint: Option<String>,
    force_path_style: Option<bool>,
    access_key: Option<String>,
    secret_key: Option<String>,
    session_token: Option<String>,
}

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct NativeSyncBundleConfig {
    mode: Option<String>,
    min_file_count: Option<usize>,
    min_total_bytes: Option<u64>,
    layout: Option<String>,
    trust_managed_prefixes: Option<bool>,
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
struct WorkerRequest {
    request_id: String,
    command: String,
    payload: Option<Value>,
    #[serde(default)]
    sent_at_ms: Option<u128>,
}

#[derive(Default)]
struct Snapshot {
    files: Vec<FileEntry>,
    files_sorted_by_relative_path: bool,
    directories: BTreeSet<String>,
    empty_directories: BTreeSet<String>,
    ignored_paths: Vec<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ScanLocalTreeResponse {
    ok: bool,
    protocol_version: u32,
    fingerprint: String,
    files: Vec<ScanFileEntry>,
    directories: Vec<String>,
    empty_directories: Vec<String>,
}

#[derive(Clone)]
struct FileEntry {
    relative_path: String,
    absolute_path: String,
    size: u64,
    mtime_ms: u128,
    mode: u32,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ScanFileEntry {
    relative_path: String,
    absolute_path: String,
    size: u64,
    mtime_ms: u128,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct PlanLocalToRemoteRequest {
    root_dir: String,
    #[serde(default)]
    exclude_relative_paths: Vec<String>,
    #[serde(default)]
    preserve_top_level_names: Vec<String>,
    #[serde(default)]
    remote_entries: Vec<PlanRemoteEntry>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct PlanSeedUploadRequest {
    root_dir: String,
    remote_base_path: String,
    #[serde(default)]
    exclude_relative_paths: Vec<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct BuildSeedArchiveRequest {
    root_dir: String,
    archive_path: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct BuildSeedArchiveResponse {
    ok: bool,
    protocol_version: u32,
    archive_path: String,
    archive_bytes: u64,
    file_count: usize,
    empty_directory_count: usize,
}

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PlanRemoteEntry {
    relative_path: String,
    key: String,
    size: u64,
    #[allow(dead_code)]
    last_modified_ms: Option<u128>,
    is_directory: bool,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SyncManifestFileEntry {
    size: u64,
    mtime_ms: u128,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SyncManifestDocument {
    version: u32,
    files: BTreeMap<String, SyncManifestFileEntry>,
    #[serde(default)]
    empty_directories: Vec<String>,
    #[serde(default)]
    storage_mode: Option<String>,
}

struct RemoteEntryListing {
    entries: Vec<PlanRemoteEntry>,
    has_sync_manifest: bool,
    bundle_entry: Option<PlanRemoteEntry>,
}

#[derive(Clone, Copy, Eq, PartialEq)]
enum SyncBundleMode {
    Off,
    Auto,
    Force,
}

#[derive(Clone, Copy, Eq, PartialEq)]
enum SyncBundleLayout {
    Sidecar,
    Primary,
}

#[derive(Clone, Copy)]
struct ResolvedSyncBundleConfig {
    mode: SyncBundleMode,
    min_file_count: usize,
    min_total_bytes: u64,
    layout: SyncBundleLayout,
    trust_managed_prefixes: bool,
}

static TRUSTED_MANAGED_PREFIX_CACHE: OnceLock<Mutex<HashSet<String>>> = OnceLock::new();

#[derive(Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
struct ObjectStoreRequestCounts {
    list_requests: usize,
    get_requests: usize,
    head_requests: usize,
    put_requests: usize,
    delete_requests: usize,
}

#[derive(Default)]
struct NativeObjectStoreRequestCounter {
    list_requests: AtomicUsize,
    get_requests: AtomicUsize,
    head_requests: AtomicUsize,
    put_requests: AtomicUsize,
    delete_requests: AtomicUsize,
}

impl NativeObjectStoreRequestCounter {
    fn increment_list(&self) {
        self.list_requests.fetch_add(1, Ordering::Relaxed);
    }

    fn increment_get(&self) {
        self.get_requests.fetch_add(1, Ordering::Relaxed);
    }

    fn increment_head(&self) {
        self.head_requests.fetch_add(1, Ordering::Relaxed);
    }

    fn increment_put(&self) {
        self.put_requests.fetch_add(1, Ordering::Relaxed);
    }

    fn increment_delete(&self) {
        self.delete_requests.fetch_add(1, Ordering::Relaxed);
    }

    fn snapshot(&self) -> ObjectStoreRequestCounts {
        ObjectStoreRequestCounts {
            list_requests: self.list_requests.load(Ordering::Relaxed),
            get_requests: self.get_requests.load(Ordering::Relaxed),
            head_requests: self.head_requests.load(Ordering::Relaxed),
            put_requests: self.put_requests.load(Ordering::Relaxed),
            delete_requests: self.delete_requests.load(Ordering::Relaxed),
        }
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct PlanLocalToRemoteResponse {
    ok: bool,
    protocol_version: u32,
    fingerprint: String,
    upload_candidates: Vec<PlanUploadCandidate>,
    info_check_candidates: Vec<PlanUploadCandidate>,
    empty_directories_to_create: Vec<String>,
    keys_to_delete: Vec<String>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct PlanUploadCandidate {
    relative_path: String,
    absolute_path: String,
    size: u64,
    mtime_ms: u128,
    remote_key: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct PlanDownloadCandidate {
    relative_path: String,
    target_path: String,
    size: u64,
    remote_key: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct PlanRemoteToLocalResponse {
    ok: bool,
    protocol_version: u32,
    remove_paths: Vec<String>,
    directories_to_create: Vec<String>,
    download_candidates: Vec<PlanDownloadCandidate>,
    info_check_candidates: Vec<PlanDownloadCandidate>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct PlanSeedUploadResponse {
    ok: bool,
    protocol_version: u32,
    fingerprint: String,
    directories: Vec<String>,
    files: Vec<PlanSeedUploadFile>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct PlanSeedUploadFile {
    relative_path: String,
    absolute_path: String,
    remote_path: String,
    size: u64,
    mtime_ms: u128,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct SyncLocalToRemotePhaseTimings {
    scan_ms: u64,
    fingerprint_ms: u64,
    client_create_ms: u64,
    manifest_read_ms: u64,
    bundle_build_ms: u64,
    bundle_body_prepare_ms: u64,
    bundle_upload_ms: u64,
    bundle_transport: String,
    bundle_bytes: u64,
    manifest_write_ms: u64,
    delete_ms: u64,
    total_primary_path_ms: u64,
    total_command_ms: u64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct SyncRemoteToLocalPhaseTimings {
    scan_ms: u64,
    client_create_ms: u64,
    listing_ms: u64,
    manifest_read_ms: u64,
    plan_ms: u64,
    remove_ms: u64,
    mkdir_ms: u64,
    bundle_get_ms: u64,
    bundle_body_read_ms: u64,
    bundle_extract_ms: u64,
    bundle_extract_mkdir_us: u64,
    bundle_extract_replace_us: u64,
    bundle_extract_file_create_us: u64,
    bundle_extract_file_write_us: u64,
    bundle_extract_file_mtime_us: u64,
    bundle_extract_chmod_us: u64,
    bundle_extract_target_check_us: u64,
    bundle_extract_file_count: u64,
    bundle_extract_directory_count: u64,
    bundle_transport: String,
    bundle_extractor: String,
    bundle_bytes: u64,
    download_ms: u64,
    info_check_ms: u64,
    fingerprint_ms: u64,
    total_command_ms: u64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct WorkerRequestTimings {
    receive_delay_ms: u64,
    parse_ms: u64,
    handle_ms: u64,
    serialize_ms: u64,
    write_ms: u64,
    total_worker_ms: u64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct SyncLocalToRemoteResponse {
    ok: bool,
    protocol_version: u32,
    local_fingerprint: String,
    uploaded_file_count: usize,
    deleted_remote_count: usize,
    created_empty_directory_count: usize,
    request_counts: ObjectStoreRequestCounts,
    #[serde(skip_serializing_if = "Option::is_none")]
    phase_timings: Option<SyncLocalToRemotePhaseTimings>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct SyncRemoteToLocalResponse {
    ok: bool,
    protocol_version: u32,
    local_fingerprint: String,
    removed_path_count: usize,
    created_directory_count: usize,
    downloaded_file_count: usize,
    request_counts: ObjectStoreRequestCounts,
    #[serde(skip_serializing_if = "Option::is_none")]
    phase_timings: Option<SyncRemoteToLocalPhaseTimings>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct SyncLocalToSandboxHttpResponse {
    ok: bool,
    protocol_version: u32,
    local_fingerprint: String,
    created_directory_count: usize,
    uploaded_file_count: usize,
}

fn main() -> ExitCode {
    match run() {
        Ok(()) => ExitCode::SUCCESS,
        Err(error) => {
            let payload = ErrorResponse {
                ok: false,
                protocol_version: PROTOCOL_VERSION,
                code: "native_workspace_sync_failed",
                message: error,
            };
            let rendered = serde_json::to_string(&payload).unwrap_or_else(|serialization_error| {
                format!(
                    "{{\"ok\":false,\"protocolVersion\":{},\"code\":\"native_workspace_sync_failed\",\"message\":\"{}\"}}",
                    PROTOCOL_VERSION, serialization_error
                )
            });
            eprintln!("{rendered}");
            ExitCode::FAILURE
        }
    }
}

fn run() -> Result<(), String> {
    let cli = Cli::parse();
    match cli.command {
        Command::Ready => write_json_value(&handle_command("ready", None, None)?),
        Command::Version => write_json_value(&handle_command("version", None, None)?),
        Command::Serve => serve(),
        Command::Fingerprint => write_json_value(&handle_command(
            "fingerprint",
            Some(read_json_stdin_value()?),
            None,
        )?),
        Command::FingerprintBatch => write_json_value(&handle_command(
            "fingerprint-batch",
            Some(read_json_stdin_value()?),
            None,
        )?),
        Command::ScanLocalTree => write_json_value(&handle_command(
            "scan-local-tree",
            Some(read_json_stdin_value()?),
            None,
        )?),
        Command::PlanLocalToRemote => write_json_value(&handle_command(
            "plan-local-to-remote",
            Some(read_json_stdin_value()?),
            None,
        )?),
        Command::SyncLocalToRemote => {
            let runtime = build_runtime()?;
            write_json_value(&handle_command(
                "sync-local-to-remote",
                Some(read_json_stdin_value()?),
                Some(&runtime),
            )?)
        }
        Command::PlanRemoteToLocal => write_json_value(&handle_command(
            "plan-remote-to-local",
            Some(read_json_stdin_value()?),
            None,
        )?),
        Command::SyncRemoteToLocal => {
            let runtime = build_runtime()?;
            write_json_value(&handle_command(
                "sync-remote-to-local",
                Some(read_json_stdin_value()?),
                Some(&runtime),
            )?)
        }
        Command::PlanSeedUpload => write_json_value(&handle_command(
            "plan-seed-upload",
            Some(read_json_stdin_value()?),
            None,
        )?),
        Command::BuildSeedArchive => write_json_value(&handle_command(
            "build-seed-archive",
            Some(read_json_stdin_value()?),
            None,
        )?),
        Command::SyncLocalToSandboxHttp => {
            let runtime = build_runtime()?;
            write_json_value(&handle_command(
                "sync-local-to-sandbox-http",
                Some(read_json_stdin_value()?),
                Some(&runtime),
            )?)
        }
    }
}

struct LocalToRemotePlan {
    upload_candidates: Vec<PlanUploadCandidate>,
    info_check_candidates: Vec<PlanUploadCandidate>,
    empty_directories_to_create: Vec<String>,
    keys_to_delete: Vec<String>,
}

struct RemoteToLocalPlan {
    remove_paths: Vec<String>,
    directories_to_create: Vec<String>,
    download_candidates: Vec<PlanDownloadCandidate>,
    info_check_candidates: Vec<PlanDownloadCandidate>,
}

struct SeedUploadPlan {
    directories: Vec<String>,
    files: Vec<PlanSeedUploadFile>,
}

fn build_runtime() -> Result<tokio::runtime::Runtime, String> {
    RuntimeBuilder::new_multi_thread()
        .enable_all()
        .build()
        .map_err(|error| format!("Failed to initialize async runtime: {error}"))
}

fn warm_native_object_store_stack() {
    let _ = create_s3_client(&NativeObjectStoreConfig {
        bucket: "oah-warmup".to_string(),
        region: "us-east-1".to_string(),
        endpoint: None,
        force_path_style: Some(true),
        access_key: Some("oah-warmup".to_string()),
        secret_key: Some("oah-warmup".to_string()),
        session_token: None,
    });
}

fn read_json_stdin<T: for<'de> Deserialize<'de>>() -> Result<T, String> {
    let mut input = String::new();
    io::stdin()
        .read_to_string(&mut input)
        .map_err(|error| format!("Failed to read stdin: {error}"))?;
    serde_json::from_str::<T>(&input)
        .map_err(|error| format!("Failed to decode stdin JSON: {error}"))
}

fn read_json_stdin_value() -> Result<Value, String> {
    read_json_stdin::<Value>()
}

fn write_json<T: Serialize>(payload: &T) -> Result<(), String> {
    let rendered = serde_json::to_string(payload)
        .map_err(|error| format!("Failed to serialize JSON response: {error}"))?;
    println!("{rendered}");
    Ok(())
}

fn write_json_value(payload: &Value) -> Result<(), String> {
    write_json(payload)
}

fn parse_payload<T: DeserializeOwned>(payload: Option<Value>, command: &str) -> Result<T, String> {
    let payload = payload.ok_or_else(|| format!("Missing JSON payload for command {command}"))?;
    serde_json::from_value(payload)
        .map_err(|error| format!("Failed to decode JSON payload for command {command}: {error}"))
}

fn serialize_json_value<T: Serialize>(payload: &T) -> Result<Value, String> {
    serde_json::to_value(payload)
        .map_err(|error| format!("Failed to serialize command response: {error}"))
}

fn handle_command(
    command: &str,
    payload: Option<Value>,
    runtime: Option<&tokio::runtime::Runtime>,
) -> Result<Value, String> {
    match command {
        "ready" => serialize_json_value(&ReadyResponse {
            ok: true,
            protocol_version: PROTOCOL_VERSION,
        }),
        "version" => serialize_json_value(&VersionResponse {
            ok: true,
            protocol_version: PROTOCOL_VERSION,
            name: BINARY_NAME,
            version: BINARY_VERSION,
        }),
        "fingerprint" => {
            let request: FingerprintRequest = parse_payload(payload, command)?;
            let excludes = normalize_exclude_paths(request.exclude_relative_paths);
            let snapshot = collect_snapshot(&PathBuf::from(request.root_dir), &excludes)?;
            serialize_json_value(&FingerprintResponse {
                ok: true,
                protocol_version: PROTOCOL_VERSION,
                fingerprint: create_fingerprint(&snapshot),
                file_count: snapshot.files.len(),
                empty_directory_count: snapshot.empty_directories.len(),
            })
        }
        "fingerprint-batch" => {
            let request: FingerprintBatchRequest = parse_payload(payload, command)?;
            let mut results = Vec::with_capacity(request.directories.len());
            for directory in request.directories {
                let excludes = normalize_exclude_paths(directory.exclude_relative_paths);
                let snapshot = collect_snapshot(&PathBuf::from(&directory.root_dir), &excludes)?;
                results.push(FingerprintBatchEntry {
                    root_dir: directory.root_dir,
                    fingerprint: create_fingerprint(&snapshot),
                    file_count: snapshot.files.len(),
                    empty_directory_count: snapshot.empty_directories.len(),
                });
            }
            serialize_json_value(&FingerprintBatchResponse {
                ok: true,
                protocol_version: PROTOCOL_VERSION,
                results,
            })
        }
        "scan-local-tree" => {
            let request: FingerprintRequest = parse_payload(payload, command)?;
            let excludes = normalize_exclude_paths(request.exclude_relative_paths);
            let snapshot = collect_snapshot(&PathBuf::from(request.root_dir), &excludes)?;
            serialize_json_value(&ScanLocalTreeResponse {
                ok: true,
                protocol_version: PROTOCOL_VERSION,
                fingerprint: create_fingerprint(&snapshot),
                files: snapshot
                    .files
                    .into_iter()
                    .map(|file| ScanFileEntry {
                        relative_path: file.relative_path,
                        absolute_path: file.absolute_path,
                        size: file.size,
                        mtime_ms: file.mtime_ms,
                    })
                    .collect(),
                directories: snapshot.directories.into_iter().collect(),
                empty_directories: snapshot.empty_directories.into_iter().collect(),
            })
        }
        "plan-local-to-remote" => {
            let request: PlanLocalToRemoteRequest = parse_payload(payload, command)?;
            let excludes = normalize_exclude_paths(request.exclude_relative_paths);
            let snapshot = collect_snapshot(&PathBuf::from(request.root_dir), &excludes)?;
            let fingerprint = create_fingerprint(&snapshot);
            let plan = create_local_to_remote_plan(&snapshot, request.remote_entries);
            serialize_json_value(&PlanLocalToRemoteResponse {
                ok: true,
                protocol_version: PROTOCOL_VERSION,
                fingerprint,
                upload_candidates: plan.upload_candidates,
                info_check_candidates: plan.info_check_candidates,
                empty_directories_to_create: plan.empty_directories_to_create,
                keys_to_delete: plan.keys_to_delete,
            })
        }
        "sync-local-to-remote" => {
            let request: SyncLocalToRemoteRequest = parse_payload(payload, command)?;
            let runtime = runtime
                .ok_or_else(|| "Async runtime is required for sync-local-to-remote.".to_string())?;
            serialize_json_value(&runtime.block_on(sync_local_to_remote(request))?)
        }
        "plan-remote-to-local" => {
            let request: PlanLocalToRemoteRequest = parse_payload(payload, command)?;
            let excludes = normalize_exclude_paths(request.exclude_relative_paths);
            let root_dir = PathBuf::from(&request.root_dir);
            let snapshot = collect_snapshot(&root_dir, &excludes)?;
            let plan = create_remote_to_local_plan(
                &root_dir,
                &snapshot,
                request.remote_entries,
                normalize_exclude_paths(request.preserve_top_level_names),
            );
            serialize_json_value(&PlanRemoteToLocalResponse {
                ok: true,
                protocol_version: PROTOCOL_VERSION,
                remove_paths: plan.remove_paths,
                directories_to_create: plan.directories_to_create,
                download_candidates: plan.download_candidates,
                info_check_candidates: plan.info_check_candidates,
            })
        }
        "sync-remote-to-local" => {
            let request: SyncRemoteToLocalRequest = parse_payload(payload, command)?;
            let runtime = runtime
                .ok_or_else(|| "Async runtime is required for sync-remote-to-local.".to_string())?;
            serialize_json_value(&runtime.block_on(sync_remote_to_local(request))?)
        }
        "plan-seed-upload" => {
            let request: PlanSeedUploadRequest = parse_payload(payload, command)?;
            let excludes = normalize_exclude_paths(request.exclude_relative_paths);
            let snapshot = collect_snapshot(&PathBuf::from(request.root_dir), &excludes)?;
            let fingerprint = create_fingerprint(&snapshot);
            let plan = create_seed_upload_plan(&snapshot, &request.remote_base_path);
            serialize_json_value(&PlanSeedUploadResponse {
                ok: true,
                protocol_version: PROTOCOL_VERSION,
                fingerprint,
                directories: plan.directories,
                files: plan.files,
            })
        }
        "build-seed-archive" => {
            let request: BuildSeedArchiveRequest = parse_payload(payload, command)?;
            serialize_json_value(&build_seed_archive(request)?)
        }
        "sync-local-to-sandbox-http" => {
            let request: SyncLocalToSandboxHttpRequest = parse_payload(payload, command)?;
            let runtime = runtime.ok_or_else(|| {
                "Async runtime is required for sync-local-to-sandbox-http.".to_string()
            })?;
            serialize_json_value(&runtime.block_on(sync_local_to_sandbox_http(request))?)
        }
        _ => Err(format!("Unknown command: {command}")),
    }
}

fn command_requires_runtime(command: &str) -> bool {
    matches!(
        command,
        "sync-local-to-remote" | "sync-remote-to-local" | "sync-local-to-sandbox-http"
    )
}

fn handle_worker_request(
    request: WorkerRequest,
    runtime: &mut Option<tokio::runtime::Runtime>,
) -> Value {
    let runtime_ref = if command_requires_runtime(&request.command) {
        if runtime.is_none() {
            match build_runtime() {
                Ok(created_runtime) => {
                    *runtime = Some(created_runtime);
                }
                Err(error) => {
                    return serde_json::json!({
                        "ok": false,
                        "protocolVersion": PROTOCOL_VERSION,
                        "requestId": request.request_id,
                        "code": "native_workspace_sync_failed",
                        "message": error
                    });
                }
            }
        }
        runtime.as_ref()
    } else {
        None
    };

    match handle_command(&request.command, request.payload, runtime_ref) {
        Ok(mut payload) => {
            if let Value::Object(map) = &mut payload {
                map.insert("requestId".to_string(), Value::String(request.request_id));
            }
            payload
        }
        Err(error) => serde_json::json!({
            "ok": false,
            "protocolVersion": PROTOCOL_VERSION,
            "requestId": request.request_id,
            "code": "native_workspace_sync_failed",
            "message": error
        }),
    }
}

fn serve() -> Result<(), String> {
    let mut runtime = Some(build_runtime()?);
    warm_native_object_store_stack();
    let stdin = io::stdin();
    let stdout = io::stdout();
    let reader = BufReader::new(stdin.lock());
    let mut writer = BufWriter::new(stdout.lock());

    for line in reader.lines() {
        let line = line.map_err(|error| format!("Failed to read worker request: {error}"))?;
        if line.trim().is_empty() {
            continue;
        }

        let worker_started_at = Instant::now();
        let parse_started_at = Instant::now();
        let request = serde_json::from_str::<WorkerRequest>(&line)
            .map_err(|error| format!("Failed to decode worker request JSON: {error}"))?;
        let parse_ms = elapsed_millis_u64(parse_started_at);
        let receive_delay_ms = request
            .sent_at_ms
            .and_then(|sent_at_ms| {
                system_time_to_mtime_ms(SystemTime::now())
                    .map(|now_ms| now_ms.saturating_sub(sent_at_ms))
            })
            .map(|delay_ms| delay_ms.min(u128::from(u64::MAX)) as u64)
            .unwrap_or(0);
        let handle_started_at = Instant::now();
        let response = handle_worker_request(request, &mut runtime);
        let handle_ms = elapsed_millis_u64(handle_started_at);
        let mut response = response;
        if let Some(object) = response.as_object_mut() {
            object.insert(
                "workerTimings".to_string(),
                serde_json::to_value(WorkerRequestTimings {
                    receive_delay_ms,
                    parse_ms,
                    handle_ms,
                    serialize_ms: 0,
                    write_ms: 0,
                    total_worker_ms: elapsed_millis_u64(worker_started_at),
                })
                .map_err(|error| format!("Failed to serialize worker timings JSON: {error}"))?,
            );
        }
        let serialize_started_at = Instant::now();
        let _ = serde_json::to_string(&response)
            .map_err(|error| format!("Failed to serialize worker response JSON: {error}"))?;
        let serialize_ms = elapsed_millis_u64(serialize_started_at);
        if let Some(object) = response.as_object_mut() {
            object.insert(
                "workerTimings".to_string(),
                serde_json::to_value(WorkerRequestTimings {
                    receive_delay_ms,
                    parse_ms,
                    handle_ms,
                    serialize_ms,
                    write_ms: 0,
                    total_worker_ms: elapsed_millis_u64(worker_started_at),
                })
                .map_err(|error| format!("Failed to serialize worker timings JSON: {error}"))?,
            );
        }
        let rendered = serde_json::to_string(&response)
            .map_err(|error| format!("Failed to serialize worker response JSON: {error}"))?;
        let write_started_at = Instant::now();
        writer
            .write_all(rendered.as_bytes())
            .map_err(|error| format!("Failed to write worker response: {error}"))?;
        writer
            .write_all(b"\n")
            .map_err(|error| format!("Failed to write worker response newline: {error}"))?;
        writer
            .flush()
            .map_err(|error| format!("Failed to flush worker response: {error}"))?;
        let _write_ms = elapsed_millis_u64(write_started_at);
    }

    Ok(())
}

fn parse_object_mtime_ms(metadata: Option<&HashMap<String, String>>) -> Option<u128> {
    metadata
        .and_then(|metadata| metadata.get(OBJECT_MTIME_METADATA_KEY))
        .and_then(|value| value.parse::<u128>().ok())
        .filter(|value| *value > 0)
}

fn system_time_to_mtime_ms(value: SystemTime) -> Option<u128> {
    value
        .duration_since(UNIX_EPOCH)
        .ok()
        .map(|duration| duration.as_millis())
}

fn file_time_from_mtime_ms(value: u128) -> FileTime {
    let seconds = (value / 1000).min(i64::MAX as u128) as i64;
    let nanos = ((value % 1000) * 1_000_000) as u32;
    FileTime::from_unix_time(seconds, nanos)
}

fn resolve_max_concurrency(value: Option<usize>) -> usize {
    value.filter(|value| *value > 0).unwrap_or(1)
}

fn resolve_inline_upload_threshold_bytes(value: Option<u64>) -> u64 {
    value
        .filter(|value| *value > 0)
        .unwrap_or(INLINE_UPLOAD_THRESHOLD_BYTES)
}

fn resolve_sync_bundle_config(value: Option<&NativeSyncBundleConfig>) -> ResolvedSyncBundleConfig {
    let mode = match value
        .and_then(|config| config.mode.as_deref())
        .map(|mode| mode.trim().to_ascii_lowercase())
        .as_deref()
    {
        Some("0" | "false" | "off" | "no" | "disabled") => SyncBundleMode::Off,
        Some("1" | "true" | "on" | "yes" | "enabled" | "force") => SyncBundleMode::Force,
        _ => SyncBundleMode::Auto,
    };
    let layout = match value
        .and_then(|config| config.layout.as_deref())
        .map(|layout| layout.trim().to_ascii_lowercase())
        .as_deref()
    {
        Some("primary" | "bundle" | "bundle-only") => SyncBundleLayout::Primary,
        _ => SyncBundleLayout::Sidecar,
    };

    ResolvedSyncBundleConfig {
        mode,
        min_file_count: value
            .and_then(|config| config.min_file_count)
            .filter(|count| *count > 0)
            .unwrap_or(DEFAULT_SYNC_BUNDLE_MIN_FILE_COUNT),
        min_total_bytes: value
            .and_then(|config| config.min_total_bytes)
            .filter(|bytes| *bytes > 0)
            .unwrap_or(DEFAULT_SYNC_BUNDLE_MIN_TOTAL_BYTES),
        layout,
        trust_managed_prefixes: value
            .and_then(|config| config.trust_managed_prefixes)
            .unwrap_or(false),
    }
}

fn mark_trusted_managed_prefix_seen(remote_prefix: &str) {
    let cache = TRUSTED_MANAGED_PREFIX_CACHE.get_or_init(|| Mutex::new(HashSet::new()));
    if let Ok(mut seen) = cache.lock() {
        seen.insert(remote_prefix.to_string());
    }
}

fn should_assume_empty_trusted_managed_prefix(
    remote_prefix: &str,
    config: ResolvedSyncBundleConfig,
) -> bool {
    if !config.trust_managed_prefixes {
        return false;
    }

    let cache = TRUSTED_MANAGED_PREFIX_CACHE.get_or_init(|| Mutex::new(HashSet::new()));
    let Ok(mut seen) = cache.lock() else {
        return false;
    };
    if seen.contains(remote_prefix) {
        return false;
    }
    seen.insert(remote_prefix.to_string());
    true
}

async fn process_with_concurrency<T, R, F, Fut>(
    items: Vec<T>,
    max_concurrency: usize,
    worker: F,
) -> Result<Vec<R>, String>
where
    T: Send + 'static,
    R: Send + 'static,
    F: Fn(T) -> Fut + Send + Sync + 'static,
    Fut: Future<Output = Result<R, String>> + Send + 'static,
{
    if items.is_empty() {
        return Ok(Vec::new());
    }

    let worker = Arc::new(worker);
    let mut pending = items.into_iter();
    let mut join_set = JoinSet::new();
    let mut in_flight = 0usize;
    let limit = max_concurrency.max(1);
    let mut results = Vec::new();

    loop {
        while in_flight < limit {
            let Some(item) = pending.next() else {
                break;
            };
            let worker = Arc::clone(&worker);
            join_set.spawn(async move { worker(item).await });
            in_flight += 1;
        }

        if in_flight == 0 {
            break;
        }

        let next = join_set.join_next().await.ok_or_else(|| {
            "Native workspace sync concurrency worker exited unexpectedly.".to_string()
        })?;
        in_flight -= 1;
        let result =
            next.map_err(|error| format!("Native workspace sync worker task failed: {error}"))??;
        results.push(result);
    }

    Ok(results)
}

fn collect_snapshot(root_dir: &Path, excludes: &[String]) -> Result<Snapshot, String> {
    match fs::metadata(root_dir) {
        Ok(metadata) if metadata.is_dir() => {
            let mut snapshot = Snapshot::default();
            walk_directory(root_dir, root_dir, excludes, &mut snapshot)?;
            snapshot.files_sorted_by_relative_path = true;
            Ok(snapshot)
        }
        Ok(_) => Ok(Snapshot::default()),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(Snapshot::default()),
        Err(error) => Err(format!("Failed to stat {}: {error}", root_dir.display())),
    }
}

fn metadata_mode(metadata: &fs::Metadata, default_mode: u32) -> u32 {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mode = metadata.permissions().mode() & 0o7777;
        if mode == 0 {
            return default_mode;
        }
        mode
    }

    #[cfg(not(unix))]
    {
        let _ = metadata;
        default_mode
    }
}

fn walk_directory(
    directory: &Path,
    root_dir: &Path,
    excludes: &[String],
    snapshot: &mut Snapshot,
) -> Result<(), String> {
    let mut entries = match fs::read_dir(directory) {
        Ok(entries) => entries.collect::<Result<Vec<_>, _>>().map_err(|error| {
            format!("Failed to read directory {}: {error}", directory.display())
        })?,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(()),
        Err(error) => {
            return Err(format!(
                "Failed to read directory {}: {error}",
                directory.display()
            ))
        }
    };

    entries.sort_by(|left, right| left.file_name().cmp(&right.file_name()));

    let mut visible_children = 0usize;
    let mut suppressed_children = false;

    for entry in entries {
        let absolute_path = entry.path();
        let relative_path = match absolute_path.strip_prefix(root_dir) {
            Ok(path) => normalize_relative_path(&normalize_path(path)),
            Err(_) => continue,
        };

        if should_ignore_relative_path(&relative_path) {
            snapshot.ignored_paths.push(normalize_path(&absolute_path));
            suppressed_children = true;
            continue;
        }

        if should_exclude_relative_path(&relative_path, excludes) {
            suppressed_children = true;
            continue;
        }

        let file_type = entry.file_type().map_err(|error| {
            format!(
                "Failed to read file type for {}: {error}",
                absolute_path.display()
            )
        })?;

        visible_children += 1;

        if file_type.is_dir() {
            if !relative_path.is_empty() {
                snapshot.directories.insert(relative_path.clone());
            }
            walk_directory(&absolute_path, root_dir, excludes, snapshot)?;
            continue;
        }

        if !file_type.is_file() {
            continue;
        }

        let metadata = match entry.metadata() {
            Ok(metadata) => metadata,
            Err(error) if error.kind() == io::ErrorKind::NotFound => continue,
            Err(error) => {
                return Err(format!(
                    "Failed to read metadata for {}: {error}",
                    absolute_path.display()
                ))
            }
        };

        let mtime_ms = metadata
            .modified()
            .ok()
            .and_then(|modified_at| modified_at.duration_since(UNIX_EPOCH).ok())
            .map(|duration| duration.as_millis())
            .unwrap_or_default();

        snapshot.files.push(FileEntry {
            relative_path,
            absolute_path: normalize_path(&absolute_path),
            size: metadata.len(),
            mtime_ms,
            mode: metadata_mode(&metadata, 0o644),
        });
    }

    let relative_directory = match directory.strip_prefix(root_dir) {
        Ok(path) => normalize_relative_path(&normalize_path(path)),
        Err(_) => String::new(),
    };

    if visible_children == 0 && !relative_directory.is_empty() && !suppressed_children {
        snapshot.empty_directories.insert(relative_directory);
    }

    Ok(())
}

fn create_fingerprint(snapshot: &Snapshot) -> String {
    let mut hash = Sha1::new();
    if snapshot.files_sorted_by_relative_path {
        for file in &snapshot.files {
            hash.update(
                format!(
                    "file:{}:{}:{}\n",
                    file.relative_path, file.size, file.mtime_ms
                )
                .as_bytes(),
            );
        }
    } else {
        let mut files = snapshot.files.iter().collect::<Vec<_>>();
        files.sort_by(|left, right| left.relative_path.cmp(&right.relative_path));
        for file in files {
            hash.update(
                format!(
                    "file:{}:{}:{}\n",
                    file.relative_path, file.size, file.mtime_ms
                )
                .as_bytes(),
            );
        }
    }

    for relative_directory in &snapshot.empty_directories {
        hash.update(format!("dir:{relative_directory}\n").as_bytes());
    }

    format!("{:x}", hash.finalize())
}

fn create_fingerprint_from_entries(
    files: &[(String, u64, u128)],
    empty_directories: &BTreeSet<String>,
) -> String {
    let mut hash = Sha1::new();
    let mut sorted_files = files.iter().collect::<Vec<_>>();
    sorted_files.sort_by(|left, right| left.0.cmp(&right.0));

    for (relative_path, size, mtime_ms) in sorted_files {
        hash.update(format!("file:{relative_path}:{size}:{mtime_ms}\n").as_bytes());
    }

    for relative_directory in empty_directories {
        hash.update(format!("dir:{relative_directory}\n").as_bytes());
    }

    format!("{:x}", hash.finalize())
}

fn resolve_empty_remote_directories(
    explicit_directories: &BTreeSet<String>,
    file_paths: &BTreeSet<String>,
) -> BTreeSet<String> {
    explicit_directories
        .iter()
        .filter(|candidate| {
            let child_prefix = format!("{candidate}/");
            !explicit_directories
                .iter()
                .any(|directory| directory.starts_with(&child_prefix))
                && !file_paths
                    .iter()
                    .any(|file_path| file_path.starts_with(&child_prefix))
        })
        .cloned()
        .collect()
}

fn build_sync_manifest(
    files: &[(String, u64, u128)],
    empty_directories: &[String],
    storage_mode: Option<&str>,
) -> SyncManifestDocument {
    let mut entries = files
        .iter()
        .filter_map(|(relative_path, size, mtime_ms)| {
            let normalized = normalize_relative_path(relative_path);
            if normalized.is_empty() || should_ignore_relative_path(&normalized) {
                return None;
            }
            Some((
                normalized,
                SyncManifestFileEntry {
                    size: *size,
                    mtime_ms: *mtime_ms,
                },
            ))
        })
        .collect::<Vec<_>>();
    entries.sort_by(|left, right| left.0.cmp(&right.0));

    let mut normalized_empty_directories = empty_directories
        .iter()
        .map(|relative_path| normalize_relative_path(relative_path))
        .filter(|relative_path| {
            !relative_path.is_empty() && !should_ignore_relative_path(relative_path)
        })
        .collect::<Vec<_>>();
    normalized_empty_directories.sort();
    normalized_empty_directories.dedup();

    SyncManifestDocument {
        version: 1,
        files: entries.into_iter().collect(),
        empty_directories: normalized_empty_directories,
        storage_mode: storage_mode.map(|value| value.to_string()),
    }
}

fn is_primary_bundle_manifest(document: &SyncManifestDocument) -> bool {
    matches!(
        document
            .storage_mode
            .as_deref()
            .map(|value| value.trim().to_ascii_lowercase()),
        Some(value) if value == "bundle" || value == "primary" || value == "bundle-only"
    )
}

fn create_remote_entries_from_manifest_document(
    document: &SyncManifestDocument,
    remote_prefix: &str,
    excludes: &[String],
) -> Vec<PlanRemoteEntry> {
    let mut entries = document
        .files
        .iter()
        .filter_map(|(relative_path, entry)| {
            let normalized = normalize_relative_path(relative_path);
            if normalized.is_empty()
                || should_ignore_relative_path(&normalized)
                || should_exclude_relative_path(&normalized, excludes)
            {
                return None;
            }

            Some(PlanRemoteEntry {
                relative_path: normalized.clone(),
                key: build_remote_path(remote_prefix, &normalized),
                size: entry.size,
                last_modified_ms: Some(entry.mtime_ms),
                is_directory: false,
            })
        })
        .collect::<Vec<_>>();

    entries.extend(
        document
            .empty_directories
            .iter()
            .filter_map(|relative_path| {
                let normalized = normalize_relative_path(relative_path);
                if normalized.is_empty()
                    || should_ignore_relative_path(&normalized)
                    || should_exclude_relative_path(&normalized, excludes)
                {
                    return None;
                }

                Some(PlanRemoteEntry {
                    relative_path: normalized.clone(),
                    key: format!("{}/", build_remote_path(remote_prefix, &normalized)),
                    size: 0,
                    last_modified_ms: None,
                    is_directory: true,
                })
            }),
    );
    entries.sort_by(|left, right| left.relative_path.cmp(&right.relative_path));
    entries
}

fn count_snapshot_file_mutations(
    snapshot: &Snapshot,
    existing_manifest: Option<&SyncManifestDocument>,
) -> usize {
    let Some(existing_manifest) = existing_manifest else {
        return snapshot.files.len();
    };

    snapshot
        .files
        .iter()
        .filter(|file| {
            existing_manifest
                .files
                .get(&file.relative_path)
                .map(|entry| entry.size != file.size || entry.mtime_ms != file.mtime_ms)
                .unwrap_or(true)
        })
        .count()
}

fn count_snapshot_deleted_files(
    snapshot: &Snapshot,
    existing_manifest: Option<&SyncManifestDocument>,
) -> usize {
    let Some(existing_manifest) = existing_manifest else {
        return 0;
    };
    let local_paths = snapshot
        .files
        .iter()
        .map(|file| file.relative_path.as_str())
        .collect::<BTreeSet<_>>();
    existing_manifest
        .files
        .keys()
        .filter(|relative_path| !local_paths.contains(relative_path.as_str()))
        .count()
}

fn count_snapshot_created_empty_directories(
    snapshot: &Snapshot,
    existing_manifest: Option<&SyncManifestDocument>,
) -> usize {
    let Some(existing_manifest) = existing_manifest else {
        return snapshot.empty_directories.len();
    };
    let existing = existing_manifest
        .empty_directories
        .iter()
        .map(|relative_path| normalize_relative_path(relative_path))
        .collect::<BTreeSet<_>>();
    snapshot
        .empty_directories
        .iter()
        .filter(|relative_path| !existing.contains(*relative_path))
        .count()
}

fn should_attempt_sync_bundle(
    file_count: usize,
    total_bytes: u64,
    config: ResolvedSyncBundleConfig,
) -> bool {
    if file_count == 0 {
        return false;
    }

    match config.mode {
        SyncBundleMode::Off => false,
        SyncBundleMode::Force => true,
        SyncBundleMode::Auto => {
            file_count >= config.min_file_count || total_bytes >= config.min_total_bytes
        }
    }
}

fn should_attempt_sync_bundle_for_snapshot(
    snapshot: &Snapshot,
    config: ResolvedSyncBundleConfig,
) -> bool {
    let file_count = snapshot.files.len();
    let total_bytes = snapshot.files.iter().map(|file| file.size).sum::<u64>();
    should_attempt_sync_bundle(file_count, total_bytes, config)
}

fn should_attempt_sync_bundle_for_remote_entries(
    remote_entries: &[PlanRemoteEntry],
    config: ResolvedSyncBundleConfig,
) -> bool {
    let file_count = remote_entries
        .iter()
        .filter(|entry| !entry.is_directory)
        .count();
    let total_bytes = remote_entries
        .iter()
        .filter(|entry| !entry.is_directory)
        .map(|entry| entry.size)
        .sum::<u64>();
    should_attempt_sync_bundle(file_count, total_bytes, config)
}

fn count_remote_file_entries(remote_entries: &[PlanRemoteEntry]) -> usize {
    remote_entries
        .iter()
        .filter(|entry| !entry.is_directory)
        .count()
}

fn create_local_to_remote_plan(
    snapshot: &Snapshot,
    remote_entries: Vec<PlanRemoteEntry>,
) -> LocalToRemotePlan {
    use std::collections::{BTreeMap, BTreeSet};

    let mut remote_by_relative_path = BTreeMap::new();
    for entry in remote_entries {
        remote_by_relative_path.insert(normalize_relative_path(&entry.relative_path), entry);
    }

    let mut seen_remote_relative_paths = BTreeSet::new();
    let mut upload_candidates = Vec::new();
    let mut info_check_candidates = Vec::new();

    let mut files = snapshot.files.iter().collect::<Vec<_>>();
    files.sort_by(|left, right| left.relative_path.cmp(&right.relative_path));

    for file in files {
        let remote_entry = remote_by_relative_path.get(&file.relative_path);
        seen_remote_relative_paths.insert(file.relative_path.clone());

        let candidate = PlanUploadCandidate {
            relative_path: file.relative_path.clone(),
            absolute_path: file.absolute_path.clone(),
            size: file.size,
            mtime_ms: file.mtime_ms,
            remote_key: remote_entry
                .map(|entry| entry.key.clone())
                .unwrap_or_else(|| file.relative_path.clone()),
        };

        match remote_entry {
            None => upload_candidates.push(candidate),
            Some(entry) if entry.is_directory => upload_candidates.push(candidate),
            Some(entry) if entry.size != file.size => upload_candidates.push(candidate),
            Some(_entry) => info_check_candidates.push(candidate),
        }
    }

    let mut empty_directories_to_create = snapshot
        .empty_directories
        .iter()
        .filter(|relative_path| {
            seen_remote_relative_paths.insert((*relative_path).clone());
            match remote_by_relative_path.get(*relative_path) {
                Some(entry) => !entry.is_directory,
                None => true,
            }
        })
        .cloned()
        .collect::<Vec<_>>();
    empty_directories_to_create.sort();

    let mut keys_to_delete = remote_by_relative_path
        .into_iter()
        .filter_map(|(relative_path, entry)| {
            if relative_path == "/" || seen_remote_relative_paths.contains(&relative_path) {
                return None;
            }
            Some(entry.key)
        })
        .collect::<Vec<_>>();
    keys_to_delete.sort();

    LocalToRemotePlan {
        upload_candidates,
        info_check_candidates,
        empty_directories_to_create,
        keys_to_delete,
    }
}

fn create_remote_to_local_plan(
    root_dir: &Path,
    snapshot: &Snapshot,
    remote_entries: Vec<PlanRemoteEntry>,
    preserve_top_level_names: Vec<String>,
) -> RemoteToLocalPlan {
    use std::collections::{BTreeMap, BTreeSet};

    let local_files_by_relative_path = snapshot
        .files
        .iter()
        .map(|file| (file.relative_path.clone(), file))
        .collect::<BTreeMap<_, _>>();

    let mut remote_directories = BTreeSet::new();
    let mut remote_files = Vec::new();

    for entry in remote_entries {
        let relative_path = normalize_relative_path(&entry.relative_path);
        if relative_path.is_empty() {
            continue;
        }

        if entry.is_directory {
            add_directory_with_parents(&relative_path, &mut remote_directories);
        } else {
            let parent = Path::new(&relative_path)
                .parent()
                .map(normalize_path)
                .map(|value| normalize_relative_path(&value))
                .unwrap_or_default();
            if !parent.is_empty() {
                add_directory_with_parents(&parent, &mut remote_directories);
            }
            remote_files.push((relative_path, entry));
        }
    }

    let mut directories_to_create = remote_directories.iter().cloned().collect::<Vec<_>>();
    directories_to_create.sort_by(|left, right| {
        let depth_difference = left.split('/').count().cmp(&right.split('/').count());
        if depth_difference == std::cmp::Ordering::Equal {
            left.cmp(right)
        } else {
            depth_difference
        }
    });

    let mut download_candidates = Vec::new();
    let mut info_check_candidates = Vec::new();
    let mut remote_file_paths = BTreeSet::new();
    let mut remove_paths = snapshot.ignored_paths.clone();

    remote_files.sort_by(|left, right| left.0.cmp(&right.0));
    for (relative_path, entry) in remote_files {
        remote_file_paths.insert(relative_path.clone());
        let target_path = normalize_path(&root_dir.join(&relative_path));
        let candidate = PlanDownloadCandidate {
            relative_path: relative_path.clone(),
            target_path,
            size: entry.size,
            remote_key: entry.key,
        };

        match local_files_by_relative_path.get(&relative_path) {
            None => download_candidates.push(candidate),
            Some(local_file) if local_file.size != entry.size => {
                download_candidates.push(candidate)
            }
            Some(_) => info_check_candidates.push(candidate),
        }
    }

    for file in &snapshot.files {
        if should_preserve_top_level_name(&file.relative_path, &preserve_top_level_names) {
            continue;
        }

        if !remote_file_paths.contains(&file.relative_path) {
            remove_paths.push(file.absolute_path.clone());
        }
    }

    let mut local_directories = snapshot.directories.iter().collect::<Vec<_>>();
    local_directories.sort_by(|left, right| {
        let depth_difference = right.split('/').count().cmp(&left.split('/').count());
        if depth_difference == std::cmp::Ordering::Equal {
            right.cmp(left)
        } else {
            depth_difference
        }
    });

    for relative_path in local_directories {
        if remote_directories.contains(relative_path)
            || should_preserve_top_level_name(relative_path, &preserve_top_level_names)
        {
            continue;
        }

        remove_paths.push(normalize_path(&root_dir.join(relative_path)));
    }

    remove_paths.sort();
    remove_paths.dedup();

    RemoteToLocalPlan {
        remove_paths,
        directories_to_create,
        download_candidates,
        info_check_candidates,
    }
}

fn create_seed_upload_plan(snapshot: &Snapshot, remote_base_path: &str) -> SeedUploadPlan {
    let mut directories = snapshot.directories.iter().cloned().collect::<Vec<_>>();
    directories.sort_by(|left, right| {
        let depth_difference = left.split('/').count().cmp(&right.split('/').count());
        if depth_difference == std::cmp::Ordering::Equal {
            left.cmp(right)
        } else {
            depth_difference
        }
    });

    let directories = directories
        .into_iter()
        .map(|relative_path| build_remote_path(remote_base_path, &relative_path))
        .collect();

    let mut files = snapshot.files.iter().collect::<Vec<_>>();
    files.sort_by(|left, right| left.relative_path.cmp(&right.relative_path));
    let files = files
        .into_iter()
        .map(|file| PlanSeedUploadFile {
            relative_path: file.relative_path.clone(),
            absolute_path: file.absolute_path.clone(),
            remote_path: build_remote_path(remote_base_path, &file.relative_path),
            size: file.size,
            mtime_ms: file.mtime_ms,
        })
        .collect();

    SeedUploadPlan { directories, files }
}

fn build_seed_archive(
    request: BuildSeedArchiveRequest,
) -> Result<BuildSeedArchiveResponse, String> {
    let root_dir = PathBuf::from(&request.root_dir);
    let archive_path = PathBuf::from(&request.archive_path);
    let snapshot = collect_snapshot(&root_dir, &[])?;
    let archive_parent = archive_path.parent().ok_or_else(|| {
        format!(
            "Failed to resolve parent directory for seed archive {}.",
            archive_path.display()
        )
    })?;
    fs::create_dir_all(archive_parent).map_err(|error| {
        format!(
            "Failed to create seed archive directory {}: {error}",
            archive_parent.display()
        )
    })?;

    let mut archive_file = tempfile::Builder::new()
        .prefix(".oah-seed-")
        .suffix(".tar.tmp")
        .tempfile_in(archive_parent)
        .map_err(|error| format!("Failed to create temporary seed archive file: {error}"))?;
    let relative_paths = collect_bundle_relative_paths(&snapshot);
    let wrote_with_tar =
        run_tar_with_file_list_to_path(&root_dir, &relative_paths, archive_file.path())?;
    if !wrote_with_tar {
        let mut files = snapshot.files.clone();
        files.sort_by(|left, right| left.relative_path.cmp(&right.relative_path));
        let empty_directories = snapshot
            .empty_directories
            .iter()
            .cloned()
            .collect::<Vec<_>>();
        write_snapshot_tar_archive(archive_file.as_file_mut(), &files, &empty_directories)
            .map_err(|error| format!("Failed to build seed archive: {error}"))?;
    }
    archive_file
        .as_file_mut()
        .flush()
        .map_err(|error| format!("Failed to flush seed archive: {error}"))?;

    let temp_archive_path = archive_file.into_temp_path();
    fs::rename(&temp_archive_path, &archive_path).map_err(|error| {
        format!(
            "Failed to move temporary seed archive {} to {}: {error}",
            temp_archive_path.display(),
            archive_path.display()
        )
    })?;
    let archive_bytes = fs::metadata(&archive_path)
        .map_err(|error| {
            format!(
                "Failed to stat seed archive {} after build: {error}",
                archive_path.display()
            )
        })?
        .len();

    Ok(BuildSeedArchiveResponse {
        ok: true,
        protocol_version: PROTOCOL_VERSION,
        archive_path: normalize_path(&archive_path),
        archive_bytes,
        file_count: snapshot.files.len(),
        empty_directory_count: snapshot.empty_directories.len(),
    })
}

fn create_s3_client(config: &NativeObjectStoreConfig) -> S3Client {
    let mut builder = aws_sdk_s3::config::Builder::new().region(Region::new(config.region.clone()));
    if let Some(endpoint) = &config.endpoint {
        builder = builder.endpoint_url(endpoint);
    }
    if let Some(force_path_style) = config.force_path_style {
        builder = builder.force_path_style(force_path_style);
    }
    if let (Some(access_key), Some(secret_key)) = (&config.access_key, &config.secret_key) {
        builder = builder.credentials_provider(Credentials::new(
            access_key.clone(),
            secret_key.clone(),
            config.session_token.clone(),
            None,
            "oah-workspace-sync",
        ));
    }

    S3Client::from_conf(builder.build())
}

async fn list_remote_entries(
    client: &S3Client,
    config: &NativeObjectStoreConfig,
    remote_prefix: &str,
    request_counter: &NativeObjectStoreRequestCounter,
) -> Result<RemoteEntryListing, String> {
    let normalized_prefix = normalize_relative_path(remote_prefix);
    let mut continuation_token = None;
    let mut entries = Vec::new();
    let mut has_sync_manifest = false;
    let mut bundle_entry = None;

    loop {
        let mut request = client
            .list_objects_v2()
            .bucket(&config.bucket)
            .set_continuation_token(continuation_token.clone());
        if !normalized_prefix.is_empty() {
            request = request.prefix(format!("{normalized_prefix}/"));
        }

        request_counter.increment_list();
        let response = request
            .send()
            .await
            .map_err(|error| format!("Failed to list S3 prefix {normalized_prefix}: {error}"))?;

        for item in response.contents() {
            let Some(key) = item.key() else {
                continue;
            };
            let Some(relative_path) = relative_path_from_remote_key(&normalized_prefix, key) else {
                continue;
            };
            let normalized_relative_path = normalize_relative_path(&relative_path);
            if normalized_relative_path == INTERNAL_SYNC_MANIFEST_RELATIVE_PATH {
                has_sync_manifest = true;
                continue;
            }
            if normalized_relative_path == INTERNAL_SYNC_BUNDLE_RELATIVE_PATH {
                bundle_entry = Some(PlanRemoteEntry {
                    relative_path,
                    key: key.to_string(),
                    size: item.size().unwrap_or_default().max(0) as u64,
                    last_modified_ms: item
                        .last_modified()
                        .and_then(|value| value.to_millis().ok())
                        .map(|value| value.max(0) as u128),
                    is_directory: false,
                });
                continue;
            }
            if should_ignore_relative_path(&relative_path) {
                continue;
            }

            entries.push(PlanRemoteEntry {
                relative_path,
                key: key.to_string(),
                size: item.size().unwrap_or_default() as u64,
                last_modified_ms: item
                    .last_modified()
                    .and_then(|value| value.to_millis().ok())
                    .map(|value| value.max(0) as u128),
                is_directory: key.ends_with('/'),
            });
        }

        if response.is_truncated().unwrap_or(false) {
            continuation_token = response
                .next_continuation_token()
                .map(|value| value.to_string());
        } else {
            break;
        }
    }

    Ok(RemoteEntryListing {
        entries,
        has_sync_manifest,
        bundle_entry,
    })
}

async fn load_remote_sync_manifest_document(
    client: &S3Client,
    config: &NativeObjectStoreConfig,
    remote_prefix: &str,
    request_counter: &NativeObjectStoreRequestCounter,
) -> Result<Option<SyncManifestDocument>, String> {
    let key = build_remote_path(remote_prefix, INTERNAL_SYNC_MANIFEST_RELATIVE_PATH);
    request_counter.increment_get();
    let response = match client
        .get_object()
        .bucket(&config.bucket)
        .key(&key)
        .send()
        .await
    {
        Ok(response) => response,
        Err(_) => return Ok(None),
    };

    let mut body = response.body.into_async_read();
    let mut bytes = Vec::new();
    body.read_to_end(&mut bytes)
        .await
        .map_err(|error| format!("Failed to read sync manifest {key}: {error}"))?;
    let document = serde_json::from_slice::<SyncManifestDocument>(&bytes)
        .map_err(|error| format!("Failed to parse sync manifest {key}: {error}"))?;
    if document.version != 1 {
        return Ok(None);
    }

    Ok(Some(document))
}

async fn load_remote_sync_manifest(
    client: &S3Client,
    config: &NativeObjectStoreConfig,
    remote_prefix: &str,
    has_sync_manifest: bool,
    request_counter: &NativeObjectStoreRequestCounter,
) -> Result<BTreeMap<String, SyncManifestFileEntry>, String> {
    if !has_sync_manifest {
        return Ok(BTreeMap::new());
    }

    let Some(document) =
        load_remote_sync_manifest_document(client, config, remote_prefix, request_counter).await?
    else {
        return Ok(BTreeMap::new());
    };

    Ok(document
        .files
        .into_iter()
        .filter_map(|(relative_path, entry)| {
            let normalized = normalize_relative_path(&relative_path);
            if normalized.is_empty() || should_ignore_relative_path(&normalized) {
                return None;
            }
            Some((normalized, entry))
        })
        .collect())
}

async fn write_remote_sync_manifest(
    client: &S3Client,
    config: &NativeObjectStoreConfig,
    remote_prefix: &str,
    files: &[(String, u64, u128)],
    empty_directories: &[String],
    storage_mode: Option<&str>,
    existing_manifest: Option<&SyncManifestDocument>,
    request_counter: &NativeObjectStoreRequestCounter,
) -> Result<(), String> {
    let manifest = build_sync_manifest(files, empty_directories, storage_mode);
    if let Some(existing_manifest) = existing_manifest {
        if existing_manifest.files.len() == manifest.files.len()
            && existing_manifest.empty_directories == manifest.empty_directories
            && existing_manifest.storage_mode == manifest.storage_mode
            && manifest.files.iter().all(|(relative_path, entry)| {
                existing_manifest
                    .files
                    .get(relative_path)
                    .map(|existing| {
                        existing.size == entry.size && existing.mtime_ms == entry.mtime_ms
                    })
                    .unwrap_or(false)
            })
        {
            return Ok(());
        }
    }

    let key = build_remote_path(remote_prefix, INTERNAL_SYNC_MANIFEST_RELATIVE_PATH);
    let body = serde_json::to_vec(&manifest)
        .map_err(|error| format!("Failed to serialize sync manifest {key}: {error}"))?;
    request_counter.increment_put();
    client
        .put_object()
        .bucket(&config.bucket)
        .key(&key)
        .body(ByteStream::from(body))
        .send()
        .await
        .map_err(|error| format!("Failed to write sync manifest {key}: {error}"))?;
    Ok(())
}

struct UploadSyncBundleResult {
    bundle_build_ms: u64,
    bundle_body_prepare_ms: u64,
    bundle_upload_ms: u64,
    bundle_transport: &'static str,
    bundle_bytes: u64,
}

async fn upload_sync_bundle(
    client: &S3Client,
    config: &NativeObjectStoreConfig,
    remote_prefix: &str,
    root_dir: &Path,
    snapshot: &Snapshot,
    excludes: &[String],
    request_counter: &NativeObjectStoreRequestCounter,
) -> Result<UploadSyncBundleResult, String> {
    let key = build_remote_path(remote_prefix, INTERNAL_SYNC_BUNDLE_RELATIVE_PATH);
    let bundle_build_started_at = Instant::now();
    let bundle = build_local_sync_bundle(root_dir, snapshot, excludes).await?;
    let bundle_build_ms = elapsed_millis_u64(bundle_build_started_at);
    request_counter.increment_put();
    match bundle {
        BuiltSyncBundle::Bytes(bundle_bytes) => {
            let bundle_len = bundle_bytes.len() as u64;
            let bundle_body_prepare_ms = 0;
            let bundle_upload_started_at = Instant::now();
            client
                .put_object()
                .bucket(&config.bucket)
                .key(&key)
                .content_length(bundle_bytes.len() as i64)
                .body(ByteStream::from(bundle_bytes))
                .send()
                .await
                .map_err(|error| format!("Failed to write sync bundle object: {error}"))?;
            Ok(UploadSyncBundleResult {
                bundle_build_ms,
                bundle_body_prepare_ms,
                bundle_upload_ms: elapsed_millis_u64(bundle_upload_started_at),
                bundle_transport: "memory",
                bundle_bytes: bundle_len,
            })
        }
        BuiltSyncBundle::TempPath(bundle_path) => {
            let bundle_path_ref = bundle_path.as_ref() as &Path;
            let bundle_len = tokio::fs::metadata(bundle_path_ref)
                .await
                .map_err(|error| format!("Failed to stat sync bundle file for upload: {error}"))?
                .len();
            let bundle_body_prepare_started_at = Instant::now();
            let body = ByteStream::read_from()
                .path(bundle_path_ref)
                .build()
                .await
                .map_err(|error| {
                    format!("Failed to stream sync bundle file for upload: {error}")
                })?;
            let bundle_body_prepare_ms = elapsed_millis_u64(bundle_body_prepare_started_at);
            let bundle_upload_started_at = Instant::now();
            client
                .put_object()
                .bucket(&config.bucket)
                .key(&key)
                .content_length(bundle_len as i64)
                .body(body)
                .send()
                .await
                .map_err(|error| format!("Failed to write sync bundle object: {error}"))?;
            Ok(UploadSyncBundleResult {
                bundle_build_ms,
                bundle_body_prepare_ms,
                bundle_upload_ms: elapsed_millis_u64(bundle_upload_started_at),
                bundle_transport: "tempfile",
                bundle_bytes: bundle_len,
            })
        }
    }
}

async fn delete_remote_object_if_present(
    client: &S3Client,
    config: &NativeObjectStoreConfig,
    key: &str,
    request_counter: &NativeObjectStoreRequestCounter,
) -> Result<(), String> {
    let delete = Delete::builder()
        .objects(
            ObjectIdentifier::builder()
                .key(key)
                .build()
                .map_err(|error| {
                    format!("Failed to prepare S3 delete object identifier: {error}")
                })?,
        )
        .build()
        .map_err(|error| format!("Failed to prepare S3 delete request: {error}"))?;
    request_counter.increment_delete();
    client
        .delete_objects()
        .bucket(&config.bucket)
        .delete(delete)
        .send()
        .await
        .map_err(|error| format!("Failed to delete S3 object {key}: {error}"))?;
    Ok(())
}

#[derive(Clone)]
struct HydrateSyncBundleResult {
    hydrated: bool,
    bundle_get_ms: u64,
    bundle_body_read_ms: u64,
    bundle_extract_ms: u64,
    bundle_extract_timings: SyncBundleExtractTimings,
    bundle_transport: &'static str,
    bundle_extractor: &'static str,
    bundle_bytes: u64,
}

impl HydrateSyncBundleResult {
    fn not_found() -> Self {
        Self {
            hydrated: false,
            bundle_get_ms: 0,
            bundle_body_read_ms: 0,
            bundle_extract_ms: 0,
            bundle_extract_timings: SyncBundleExtractTimings::default(),
            bundle_transport: "none",
            bundle_extractor: "none",
            bundle_bytes: 0,
        }
    }
}

fn record_hydrate_timings(
    phase_timings: &mut SyncRemoteToLocalPhaseTimings,
    hydrate_result: &HydrateSyncBundleResult,
) {
    phase_timings.bundle_get_ms += hydrate_result.bundle_get_ms;
    phase_timings.bundle_body_read_ms += hydrate_result.bundle_body_read_ms;
    phase_timings.bundle_extract_ms += hydrate_result.bundle_extract_ms;
    phase_timings.bundle_extract_mkdir_us += hydrate_result.bundle_extract_timings.mkdir_us;
    phase_timings.bundle_extract_replace_us += hydrate_result.bundle_extract_timings.replace_us;
    phase_timings.bundle_extract_file_create_us +=
        hydrate_result.bundle_extract_timings.file_create_us;
    phase_timings.bundle_extract_file_write_us +=
        hydrate_result.bundle_extract_timings.file_write_us;
    phase_timings.bundle_extract_file_mtime_us +=
        hydrate_result.bundle_extract_timings.file_mtime_us;
    phase_timings.bundle_extract_chmod_us += hydrate_result.bundle_extract_timings.chmod_us;
    phase_timings.bundle_extract_target_check_us +=
        hydrate_result.bundle_extract_timings.target_check_us;
    phase_timings.bundle_extract_file_count += hydrate_result.bundle_extract_timings.file_count;
    phase_timings.bundle_extract_directory_count +=
        hydrate_result.bundle_extract_timings.directory_count;
    if hydrate_result.hydrated {
        phase_timings.bundle_transport = hydrate_result.bundle_transport.to_string();
        phase_timings.bundle_extractor = hydrate_result.bundle_extractor.to_string();
        phase_timings.bundle_bytes = hydrate_result.bundle_bytes;
    }
}

async fn maybe_hydrate_from_remote_sync_bundle(
    client: &S3Client,
    config: &NativeObjectStoreConfig,
    root_dir: &Path,
    bundle_key: &str,
    require_empty_root: bool,
    request_counter: &NativeObjectStoreRequestCounter,
) -> Result<HydrateSyncBundleResult, String> {
    if require_empty_root && !is_local_directory_empty(root_dir).await? {
        return Ok(HydrateSyncBundleResult::not_found());
    }

    let hydrated = async {
        let bundle_path = tempfile::NamedTempFile::new()
            .map_err(|error| format!("Failed to create temporary sync bundle file: {error}"))?
            .into_temp_path();
        request_counter.increment_get();
        let bundle_get_started_at = Instant::now();
        let response = match client
            .get_object()
            .bucket(&config.bucket)
            .key(bundle_key)
            .send()
            .await
        {
            Ok(response) => response,
            Err(error) => {
                if error.code() == Some("NoSuchKey") {
                    return Ok(HydrateSyncBundleResult::not_found());
                }
                return Err(format!(
                    "Failed to download sync bundle {bundle_key}: {error}"
                ));
            }
        };
        let bundle_get_ms = elapsed_millis_u64(bundle_get_started_at);

        let content_length = response.content_length().unwrap_or_default().max(0) as u64;
        let extract_max_bytes = resolve_in_memory_sync_bundle_extract_max_bytes();
        if content_length > 0 && content_length <= extract_max_bytes {
            let body_read_started_at = Instant::now();
            let bundle_bytes = response
                .body
                .collect()
                .await
                .map_err(|error| format!("Failed to read sync bundle {bundle_key}: {error}"))?
                .into_bytes()
                .to_vec();
            let bundle_body_read_ms = elapsed_millis_u64(body_read_started_at);
            let bundle_bytes_len = bundle_bytes.len() as u64;
            let root_dir = root_dir.to_path_buf();
            let extract_started_at = Instant::now();
            let extract_outcome = tokio::task::spawn_blocking(move || {
                unpack_sync_bundle_bytes_blocking(root_dir, bundle_bytes, require_empty_root)
            })
            .await
            .map_err(|error| format!("Sync bundle extraction worker task failed: {error}"))??;
            return Ok(HydrateSyncBundleResult {
                hydrated: true,
                bundle_get_ms,
                bundle_body_read_ms,
                bundle_extract_ms: elapsed_millis_u64(extract_started_at),
                bundle_extract_timings: extract_outcome.timings,
                bundle_transport: "memory",
                bundle_extractor: extract_outcome.extractor,
                bundle_bytes: bundle_bytes_len,
            });
        }

        let body_read_started_at = Instant::now();
        let mut body = response.body.into_async_read();
        let mut bundle_file = tokio::fs::OpenOptions::new()
            .write(true)
            .truncate(true)
            .open(bundle_path.as_ref() as &Path)
            .await
            .map_err(|error| {
                format!(
                    "Failed to open temporary sync bundle file {}: {error}",
                    bundle_path.display()
                )
            })?;
        tokio::io::copy(&mut body, &mut bundle_file)
            .await
            .map_err(|error| format!("Failed to read sync bundle {}: {error}", bundle_key))?;
        bundle_file.flush().await.map_err(|error| {
            format!(
                "Failed to flush temporary sync bundle file {}: {error}",
                bundle_path.display()
            )
        })?;
        drop(bundle_file);
        let bundle_body_read_ms = elapsed_millis_u64(body_read_started_at);
        let bundle_bytes = tokio::fs::metadata(bundle_path.as_ref() as &Path)
            .await
            .map(|metadata| metadata.len())
            .unwrap_or(0);

        let root_dir = root_dir.to_path_buf();
        let bundle_path_buf = bundle_path.to_path_buf();
        let extract_started_at = Instant::now();
        tokio::task::spawn_blocking(move || unpack_sync_bundle_blocking(root_dir, bundle_path_buf))
            .await
            .map_err(|error| format!("Sync bundle extraction worker task failed: {error}"))??;
        Ok(HydrateSyncBundleResult {
            hydrated: true,
            bundle_get_ms,
            bundle_body_read_ms,
            bundle_extract_ms: elapsed_millis_u64(extract_started_at),
            bundle_extract_timings: SyncBundleExtractTimings::default(),
            bundle_transport: "tempfile",
            bundle_extractor: "tar",
            bundle_bytes,
        })
    }
    .await;

    match hydrated {
        Ok(found) => Ok(found),
        Err(_) => {
            let _ = tokio::fs::remove_dir_all(root_dir).await;
            let _ = tokio::fs::create_dir_all(root_dir).await;
            Ok(HydrateSyncBundleResult::not_found())
        }
    }
}

async fn upload_local_file(
    client: &S3Client,
    config: &NativeObjectStoreConfig,
    key: &str,
    absolute_path: &str,
    size: u64,
    inline_upload_threshold_bytes: u64,
    mtime_ms: u128,
    request_counter: &NativeObjectStoreRequestCounter,
) -> Result<bool, String> {
    let body = if size <= inline_upload_threshold_bytes {
        match tokio::fs::read(absolute_path).await {
            Ok(bytes) => ByteStream::from(bytes),
            Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(false),
            Err(error) => {
                return Err(format!(
                    "Failed to read local file {absolute_path} for upload: {error}"
                ))
            }
        }
    } else {
        match tokio::fs::try_exists(absolute_path).await {
            Ok(true) => {}
            Ok(false) => return Ok(false),
            Err(error) => {
                return Err(format!(
                    "Failed to stat local file {absolute_path} before upload: {error}"
                ))
            }
        }

        match ByteStream::from_path(PathBuf::from(absolute_path)).await {
            Ok(body) => body,
            Err(error) => {
                return Err(format!(
                    "Failed to stream local file {absolute_path} for upload: {error}"
                ))
            }
        }
    };

    request_counter.increment_put();
    client
        .put_object()
        .bucket(&config.bucket)
        .key(key)
        .body(body)
        .metadata(OBJECT_MTIME_METADATA_KEY, mtime_ms.to_string())
        .send()
        .await
        .map_err(|error| format!("Failed to upload S3 object {key}: {error}"))?;

    Ok(true)
}

async fn download_remote_file(
    client: &S3Client,
    config: &NativeObjectStoreConfig,
    key: &str,
    target_path: &Path,
    request_counter: &NativeObjectStoreRequestCounter,
) -> Result<u128, String> {
    request_counter.increment_get();
    let response = client
        .get_object()
        .bucket(&config.bucket)
        .key(key)
        .send()
        .await
        .map_err(|error| format!("Failed to download S3 object {key}: {error}"))?;

    let target_mtime_ms = parse_object_mtime_ms(response.metadata()).or_else(|| {
        response
            .last_modified()
            .and_then(|value| value.to_millis().ok())
            .map(|value| value.max(0) as u128)
    });

    let mut body = response.body.into_async_read();
    let mut file = tokio::fs::File::create(target_path)
        .await
        .map_err(|error| {
            format!(
                "Failed to create local file {}: {error}",
                target_path.display()
            )
        })?;
    tokio::io::copy(&mut body, &mut file)
        .await
        .map_err(|error| {
            format!(
                "Failed to write local file {} from S3 object {key}: {error}",
                target_path.display()
            )
        })?;
    file.flush().await.map_err(|error| {
        format!(
            "Failed to flush local file {} after download: {error}",
            target_path.display()
        )
    })?;
    drop(file);

    if let Some(target_mtime_ms) = target_mtime_ms {
        set_file_mtime(target_path, file_time_from_mtime_ms(target_mtime_ms)).map_err(|error| {
            format!(
                "Failed to preserve mtime for local file {}: {error}",
                target_path.display()
            )
        })?;
        return Ok(target_mtime_ms);
    }

    let metadata = tokio::fs::metadata(target_path).await.map_err(|error| {
        format!(
            "Failed to read metadata for downloaded local file {}: {error}",
            target_path.display()
        )
    })?;
    metadata
        .modified()
        .ok()
        .and_then(system_time_to_mtime_ms)
        .ok_or_else(|| {
            format!(
                "Failed to resolve mtime for downloaded local file {}.",
                target_path.display()
            )
        })
}

async fn sync_remote_to_local(
    request: SyncRemoteToLocalRequest,
) -> Result<SyncRemoteToLocalResponse, String> {
    let command_started_at = Instant::now();
    let excludes = normalize_exclude_paths(request.exclude_relative_paths);
    let preserve_top_level_names = normalize_exclude_paths(request.preserve_top_level_names);
    let max_concurrency = resolve_max_concurrency(request.max_concurrency);
    let sync_bundle_config = resolve_sync_bundle_config(request.sync_bundle.as_ref());
    let root_dir = PathBuf::from(&request.root_dir);
    let scan_started_at = Instant::now();
    let snapshot = collect_snapshot(&root_dir, &excludes)?;
    let mut phase_timings = SyncRemoteToLocalPhaseTimings {
        scan_ms: elapsed_millis_u64(scan_started_at),
        client_create_ms: 0,
        listing_ms: 0,
        manifest_read_ms: 0,
        plan_ms: 0,
        remove_ms: 0,
        mkdir_ms: 0,
        bundle_get_ms: 0,
        bundle_body_read_ms: 0,
        bundle_extract_ms: 0,
        bundle_extract_mkdir_us: 0,
        bundle_extract_replace_us: 0,
        bundle_extract_file_create_us: 0,
        bundle_extract_file_write_us: 0,
        bundle_extract_file_mtime_us: 0,
        bundle_extract_chmod_us: 0,
        bundle_extract_target_check_us: 0,
        bundle_extract_file_count: 0,
        bundle_extract_directory_count: 0,
        bundle_transport: "none".to_string(),
        bundle_extractor: "none".to_string(),
        bundle_bytes: 0,
        download_ms: 0,
        info_check_ms: 0,
        fingerprint_ms: 0,
        total_command_ms: 0,
    };

    let client_create_started_at = Instant::now();
    let client = create_s3_client(&request.object_store);
    phase_timings.client_create_ms = elapsed_millis_u64(client_create_started_at);
    let request_counts = Arc::new(NativeObjectStoreRequestCounter::default());
    if request.remote_entries.is_none() && sync_bundle_config.mode != SyncBundleMode::Off {
        let bundle_key =
            build_remote_path(&request.remote_prefix, INTERNAL_SYNC_BUNDLE_RELATIVE_PATH);
        let hydrate_result = maybe_hydrate_from_remote_sync_bundle(
            &client,
            &request.object_store,
            &root_dir,
            &bundle_key,
            true,
            request_counts.as_ref(),
        )
        .await?;
        record_hydrate_timings(&mut phase_timings, &hydrate_result);
        if hydrate_result.hydrated {
            let fingerprint_started_at = Instant::now();
            let hydrated_snapshot = collect_snapshot(&root_dir, &excludes)?;
            let local_fingerprint = create_fingerprint(&hydrated_snapshot);
            phase_timings.fingerprint_ms = elapsed_millis_u64(fingerprint_started_at);
            phase_timings.total_command_ms = elapsed_millis_u64(command_started_at);
            return Ok(SyncRemoteToLocalResponse {
                ok: true,
                protocol_version: PROTOCOL_VERSION,
                local_fingerprint,
                removed_path_count: 0,
                created_directory_count: 0,
                downloaded_file_count: hydrated_snapshot.files.len(),
                request_counts: request_counts.snapshot(),
                phase_timings: Some(phase_timings),
            });
        }
    }

    if request.remote_entries.is_none() && sync_bundle_config.layout == SyncBundleLayout::Primary {
        let manifest_read_started_at = Instant::now();
        let manifest_document = load_remote_sync_manifest_document(
            &client,
            &request.object_store,
            &request.remote_prefix,
            request_counts.as_ref(),
        )
        .await?;
        phase_timings.manifest_read_ms += elapsed_millis_u64(manifest_read_started_at);
        if let Some(manifest_document) = manifest_document {
            if is_primary_bundle_manifest(&manifest_document) {
                let remote_entries = create_remote_entries_from_manifest_document(
                    &manifest_document,
                    &request.remote_prefix,
                    &excludes,
                );
                let plan_started_at = Instant::now();
                let plan = create_remote_to_local_plan(
                    &root_dir,
                    &snapshot,
                    remote_entries.clone(),
                    preserve_top_level_names.clone(),
                );
                phase_timings.plan_ms += elapsed_millis_u64(plan_started_at);

                let remove_started_at = Instant::now();
                let removed_path_count = process_with_concurrency(
                    plan.remove_paths.clone(),
                    max_concurrency,
                    |target_path| async move { remove_local_path(Path::new(&target_path)).await },
                )
                .await?
                .into_iter()
                .filter(|removed| *removed)
                .count();
                phase_timings.remove_ms += elapsed_millis_u64(remove_started_at);

                let mkdir_started_at = Instant::now();
                tokio::fs::create_dir_all(&root_dir)
                    .await
                    .map_err(|error| {
                        format!(
                            "Failed to create local root directory {}: {error}",
                            root_dir.display()
                        )
                    })?;

                let root_dir_for_directories = root_dir.clone();
                let created_directory_count = process_with_concurrency(
                    plan.directories_to_create.clone(),
                    max_concurrency,
                    move |relative_path| {
                        let root_dir = root_dir_for_directories.clone();
                        async move {
                            let target_path = root_dir.join(relative_path);
                            ensure_local_directory(&target_path).await
                        }
                    },
                )
                .await?
                .into_iter()
                .filter(|created| *created)
                .count();
                phase_timings.mkdir_ms += elapsed_millis_u64(mkdir_started_at);

                let bundle_key =
                    build_remote_path(&request.remote_prefix, INTERNAL_SYNC_BUNDLE_RELATIVE_PATH);
                let hydrate_result = maybe_hydrate_from_remote_sync_bundle(
                    &client,
                    &request.object_store,
                    &root_dir,
                    &bundle_key,
                    false,
                    request_counts.as_ref(),
                )
                .await?;
                record_hydrate_timings(&mut phase_timings, &hydrate_result);
                if hydrate_result.hydrated {
                    let manifest_files = manifest_document
                        .files
                        .iter()
                        .filter_map(|(relative_path, entry)| {
                            let normalized = normalize_relative_path(relative_path);
                            if normalized.is_empty()
                                || should_ignore_relative_path(&normalized)
                                || should_exclude_relative_path(&normalized, &excludes)
                            {
                                return None;
                            }
                            Some((normalized, entry.size, entry.mtime_ms))
                        })
                        .collect::<Vec<_>>();
                    let explicit_remote_directories = manifest_document
                        .empty_directories
                        .iter()
                        .map(|relative_path| normalize_relative_path(relative_path))
                        .filter(|relative_path| {
                            !relative_path.is_empty()
                                && !should_ignore_relative_path(relative_path)
                                && !should_exclude_relative_path(relative_path, &excludes)
                        })
                        .collect::<BTreeSet<_>>();
                    let remote_file_paths = manifest_files
                        .iter()
                        .map(|(relative_path, _, _)| relative_path.clone())
                        .collect::<BTreeSet<_>>();

                    let fingerprint_started_at = Instant::now();
                    let local_fingerprint = create_fingerprint_from_entries(
                        &manifest_files,
                        &resolve_empty_remote_directories(
                            &explicit_remote_directories,
                            &remote_file_paths,
                        ),
                    );
                    phase_timings.fingerprint_ms = elapsed_millis_u64(fingerprint_started_at);
                    phase_timings.total_command_ms = elapsed_millis_u64(command_started_at);
                    return Ok(SyncRemoteToLocalResponse {
                        ok: true,
                        protocol_version: PROTOCOL_VERSION,
                        local_fingerprint,
                        removed_path_count,
                        created_directory_count,
                        downloaded_file_count: manifest_files.len(),
                        request_counts: request_counts.snapshot(),
                        phase_timings: Some(phase_timings),
                    });
                }
            }
        }
    }

    let (remote_entries, has_sync_manifest, bundle_entry) = match request.remote_entries {
        Some(prefetched_remote_entries) => (
            prefetched_remote_entries,
            request.has_sync_manifest.unwrap_or(false),
            request.bundle_entry,
        ),
        None => {
            let listing_started_at = Instant::now();
            let remote_listing = list_remote_entries(
                &client,
                &request.object_store,
                &request.remote_prefix,
                request_counts.as_ref(),
            )
            .await?;
            phase_timings.listing_ms += elapsed_millis_u64(listing_started_at);
            (
                remote_listing.entries,
                remote_listing.has_sync_manifest,
                remote_listing.bundle_entry,
            )
        }
    };

    if let Some(bundle_entry) = bundle_entry.as_ref() {
        if should_attempt_sync_bundle_for_remote_entries(&remote_entries, sync_bundle_config) {
            let hydrate_result = maybe_hydrate_from_remote_sync_bundle(
                &client,
                &request.object_store,
                &root_dir,
                &bundle_entry.key,
                true,
                request_counts.as_ref(),
            )
            .await?;
            record_hydrate_timings(&mut phase_timings, &hydrate_result);
            if hydrate_result.hydrated {
                let fingerprint_started_at = Instant::now();
                let hydrated_snapshot = collect_snapshot(&root_dir, &excludes)?;
                let local_fingerprint = create_fingerprint(&hydrated_snapshot);
                phase_timings.fingerprint_ms = elapsed_millis_u64(fingerprint_started_at);
                phase_timings.total_command_ms = elapsed_millis_u64(command_started_at);
                return Ok(SyncRemoteToLocalResponse {
                    ok: true,
                    protocol_version: PROTOCOL_VERSION,
                    local_fingerprint,
                    removed_path_count: 0,
                    created_directory_count: 0,
                    downloaded_file_count: count_remote_file_entries(&remote_entries),
                    request_counts: request_counts.snapshot(),
                    phase_timings: Some(phase_timings),
                });
            }
        }
    }

    let manifest_read_started_at = Instant::now();
    let sync_manifest = Arc::new(
        load_remote_sync_manifest(
            &client,
            &request.object_store,
            &request.remote_prefix,
            has_sync_manifest,
            request_counts.as_ref(),
        )
        .await?,
    );
    phase_timings.manifest_read_ms += elapsed_millis_u64(manifest_read_started_at);
    let explicit_remote_directories = remote_entries
        .iter()
        .filter(|entry| entry.is_directory)
        .map(|entry| normalize_relative_path(&entry.relative_path))
        .filter(|relative_path| !relative_path.is_empty())
        .collect::<BTreeSet<_>>();
    let remote_file_paths = remote_entries
        .iter()
        .filter(|entry| !entry.is_directory)
        .map(|entry| normalize_relative_path(&entry.relative_path))
        .filter(|relative_path| !relative_path.is_empty())
        .collect::<BTreeSet<_>>();
    let plan_started_at = Instant::now();
    let plan = create_remote_to_local_plan(
        &root_dir,
        &snapshot,
        remote_entries,
        preserve_top_level_names,
    );
    phase_timings.plan_ms += elapsed_millis_u64(plan_started_at);

    let remove_started_at = Instant::now();
    let removed_path_count = process_with_concurrency(
        plan.remove_paths.clone(),
        max_concurrency,
        |target_path| async move { remove_local_path(Path::new(&target_path)).await },
    )
    .await?
    .into_iter()
    .filter(|removed| *removed)
    .count();
    phase_timings.remove_ms += elapsed_millis_u64(remove_started_at);

    let mkdir_started_at = Instant::now();
    tokio::fs::create_dir_all(&root_dir)
        .await
        .map_err(|error| {
            format!(
                "Failed to create local root directory {}: {error}",
                root_dir.display()
            )
        })?;

    let root_dir_for_directories = root_dir.clone();
    let created_directory_count = process_with_concurrency(
        plan.directories_to_create.clone(),
        max_concurrency,
        move |relative_path| {
            let root_dir = root_dir_for_directories.clone();
            async move {
                let target_path = root_dir.join(relative_path);
                ensure_local_directory(&target_path).await
            }
        },
    )
    .await?
    .into_iter()
    .filter(|created| *created)
    .count();
    phase_timings.mkdir_ms += elapsed_millis_u64(mkdir_started_at);

    let client_for_downloads = client.clone();
    let object_store_for_downloads = request.object_store.clone();
    let request_counts_for_downloads = Arc::clone(&request_counts);
    let download_started_at = Instant::now();
    let downloaded_candidates = process_with_concurrency(
        plan.download_candidates.clone(),
        max_concurrency,
        move |candidate| {
            let client = client_for_downloads.clone();
            let object_store = object_store_for_downloads.clone();
            let request_counts = Arc::clone(&request_counts_for_downloads);
            async move {
                let target_path = PathBuf::from(&candidate.target_path);
                prepare_local_file_target(&target_path).await?;
                let mtime_ms = download_remote_file(
                    &client,
                    &object_store,
                    &candidate.remote_key,
                    &target_path,
                    request_counts.as_ref(),
                )
                .await?;
                Ok((candidate.relative_path, candidate.size, mtime_ms, true))
            }
        },
    )
    .await?;
    phase_timings.download_ms += elapsed_millis_u64(download_started_at);

    let client_for_info_checks = client.clone();
    let object_store_for_info_checks = request.object_store.clone();
    let sync_manifest_for_info_checks = Arc::clone(&sync_manifest);
    let request_counts_for_info_checks = Arc::clone(&request_counts);
    let info_check_started_at = Instant::now();
    let info_checked_candidates = process_with_concurrency(
        plan.info_check_candidates.clone(),
        max_concurrency,
        move |candidate| {
            let client = client_for_info_checks.clone();
            let object_store = object_store_for_info_checks.clone();
            let sync_manifest = Arc::clone(&sync_manifest_for_info_checks);
            let request_counts = Arc::clone(&request_counts_for_info_checks);
            async move {
                let target_path = PathBuf::from(&candidate.target_path);
                let existing = prepare_local_file_target(&target_path).await?;

                let should_download: Result<(bool, Option<u128>), String> = match existing {
                    Some(metadata) if metadata.len() == candidate.size => {
                        if let Some(manifest_entry) = sync_manifest.get(&candidate.relative_path) {
                            let local_mtime_ms =
                                metadata.modified().ok().and_then(system_time_to_mtime_ms);
                            if manifest_entry.size == candidate.size
                                && local_mtime_ms == Some(manifest_entry.mtime_ms)
                            {
                                return Ok((
                                    candidate.relative_path,
                                    candidate.size,
                                    manifest_entry.mtime_ms,
                                    false,
                                ));
                            }
                        }

                        request_counts.increment_head();
                        let head = client
                            .head_object()
                            .bucket(&object_store.bucket)
                            .key(&candidate.remote_key)
                            .send()
                            .await;

                        match head {
                            Ok(head) => {
                                let remote_mtime_ms = parse_object_mtime_ms(head.metadata())
                                    .or_else(|| {
                                        head.last_modified()
                                            .and_then(|value| value.to_millis().ok())
                                            .map(|value| value.max(0) as u128)
                                    });
                                let local_mtime_ms =
                                    metadata.modified().ok().and_then(system_time_to_mtime_ms);
                                match (remote_mtime_ms, local_mtime_ms) {
                                    (Some(remote_mtime_ms), Some(local_mtime_ms)) => {
                                        if remote_mtime_ms != local_mtime_ms {
                                            Ok((true, None))
                                        } else {
                                            Ok((false, Some(local_mtime_ms)))
                                        }
                                    }
                                    _ => Ok((true, None)),
                                }
                            }
                            Err(_) => Ok((true, None)),
                        }
                    }
                    _ => Ok((true, None)),
                };

                let (should_download, existing_mtime_ms) = should_download?;
                if !should_download {
                    return Ok((
                        candidate.relative_path,
                        candidate.size,
                        existing_mtime_ms.unwrap_or_default(),
                        false,
                    ));
                }

                let mtime_ms = download_remote_file(
                    &client,
                    &object_store,
                    &candidate.remote_key,
                    &target_path,
                    request_counts.as_ref(),
                )
                .await?;
                Ok((candidate.relative_path, candidate.size, mtime_ms, true))
            }
        },
    )
    .await?;
    phase_timings.info_check_ms += elapsed_millis_u64(info_check_started_at);
    let downloaded_file_count = downloaded_candidates.len()
        + info_checked_candidates
            .iter()
            .filter(|(_, _, _, downloaded)| *downloaded)
            .count();
    let fingerprint_started_at = Instant::now();
    let local_fingerprint = create_fingerprint_from_entries(
        &downloaded_candidates
            .into_iter()
            .chain(info_checked_candidates.into_iter())
            .map(|(relative_path, size, mtime_ms, _downloaded)| (relative_path, size, mtime_ms))
            .collect::<Vec<_>>(),
        &resolve_empty_remote_directories(&explicit_remote_directories, &remote_file_paths),
    );
    phase_timings.fingerprint_ms = elapsed_millis_u64(fingerprint_started_at);
    phase_timings.total_command_ms = elapsed_millis_u64(command_started_at);

    Ok(SyncRemoteToLocalResponse {
        ok: true,
        protocol_version: PROTOCOL_VERSION,
        local_fingerprint,
        removed_path_count,
        created_directory_count,
        downloaded_file_count,
        request_counts: request_counts.snapshot(),
        phase_timings: Some(phase_timings),
    })
}

async fn sync_local_to_remote(
    request: SyncLocalToRemoteRequest,
) -> Result<SyncLocalToRemoteResponse, String> {
    use std::collections::BTreeMap;

    let command_started_at = Instant::now();
    let excludes = normalize_exclude_paths(request.exclude_relative_paths);
    let max_concurrency = resolve_max_concurrency(request.max_concurrency);
    let inline_upload_threshold_bytes =
        resolve_inline_upload_threshold_bytes(request.inline_upload_threshold_bytes);
    let sync_bundle_config = resolve_sync_bundle_config(request.sync_bundle.as_ref());
    let root_dir = PathBuf::from(&request.root_dir);
    let scan_started_at = Instant::now();
    let snapshot = collect_snapshot(&root_dir, &excludes)?;
    let mut phase_timings = SyncLocalToRemotePhaseTimings {
        scan_ms: elapsed_millis_u64(scan_started_at),
        fingerprint_ms: 0,
        client_create_ms: 0,
        manifest_read_ms: 0,
        bundle_build_ms: 0,
        bundle_body_prepare_ms: 0,
        bundle_upload_ms: 0,
        bundle_transport: "none".to_string(),
        bundle_bytes: 0,
        manifest_write_ms: 0,
        delete_ms: 0,
        total_primary_path_ms: 0,
        total_command_ms: 0,
    };
    let fingerprint_started_at = Instant::now();
    let local_fingerprint = create_fingerprint(&snapshot);
    phase_timings.fingerprint_ms = elapsed_millis_u64(fingerprint_started_at);

    let client_create_started_at = Instant::now();
    let client = create_s3_client(&request.object_store);
    phase_timings.client_create_ms = elapsed_millis_u64(client_create_started_at);
    let request_counts = Arc::new(NativeObjectStoreRequestCounter::default());
    let snapshot_manifest_files = snapshot
        .files
        .iter()
        .map(|file| (file.relative_path.clone(), file.size, file.mtime_ms))
        .collect::<Vec<_>>();

    if sync_bundle_config.layout == SyncBundleLayout::Primary
        && should_attempt_sync_bundle_for_snapshot(&snapshot, sync_bundle_config)
    {
        let primary_path_started_at = Instant::now();
        let assume_empty_trusted_prefix =
            should_assume_empty_trusted_managed_prefix(&request.remote_prefix, sync_bundle_config);
        let existing_manifest_document = if assume_empty_trusted_prefix {
            None
        } else {
            let manifest_read_started_at = Instant::now();
            let document = load_remote_sync_manifest_document(
                &client,
                &request.object_store,
                &request.remote_prefix,
                request_counts.as_ref(),
            )
            .await?;
            phase_timings.manifest_read_ms = elapsed_millis_u64(manifest_read_started_at);
            document
        };
        let uploaded_file_count =
            count_snapshot_file_mutations(&snapshot, existing_manifest_document.as_ref());
        let deleted_remote_count =
            count_snapshot_deleted_files(&snapshot, existing_manifest_document.as_ref());
        let created_empty_directory_count = count_snapshot_created_empty_directories(
            &snapshot,
            existing_manifest_document.as_ref(),
        );
        let has_mutations = uploaded_file_count > 0
            || deleted_remote_count > 0
            || created_empty_directory_count > 0
            || !existing_manifest_document
                .as_ref()
                .map(is_primary_bundle_manifest)
                .unwrap_or(false);

        if has_mutations {
            let upload_result = upload_sync_bundle(
                &client,
                &request.object_store,
                &request.remote_prefix,
                &root_dir,
                &snapshot,
                &excludes,
                request_counts.as_ref(),
            )
            .await?;
            phase_timings.bundle_build_ms = upload_result.bundle_build_ms;
            phase_timings.bundle_body_prepare_ms = upload_result.bundle_body_prepare_ms;
            phase_timings.bundle_upload_ms = upload_result.bundle_upload_ms;
            phase_timings.bundle_transport = upload_result.bundle_transport.to_string();
            phase_timings.bundle_bytes = upload_result.bundle_bytes;

            let snapshot_file_paths = snapshot
                .files
                .iter()
                .map(|file| file.relative_path.as_str())
                .collect::<BTreeSet<_>>();
            let snapshot_empty_directories = snapshot
                .empty_directories
                .iter()
                .map(|relative_path| relative_path.as_str())
                .collect::<BTreeSet<_>>();

            let mut keys_to_delete =
                existing_manifest_document
                    .as_ref()
                    .map(|document| {
                        let remove_all_tracked_entries = !is_primary_bundle_manifest(document);
                        let mut keys = document
                            .files
                            .keys()
                            .filter(|relative_path| {
                                remove_all_tracked_entries
                                    || !snapshot_file_paths.contains(relative_path.as_str())
                            })
                            .map(|relative_path| {
                                build_remote_path(&request.remote_prefix, relative_path)
                            })
                            .collect::<Vec<_>>();
                        keys.extend(document.empty_directories.iter().filter_map(
                            |relative_path| {
                                let normalized = normalize_relative_path(relative_path);
                                if normalized.is_empty()
                                    || (!remove_all_tracked_entries
                                        && snapshot_empty_directories.contains(normalized.as_str()))
                                {
                                    return None;
                                }
                                Some(format!(
                                    "{}/",
                                    build_remote_path(&request.remote_prefix, &normalized)
                                ))
                            },
                        ));
                        keys
                    })
                    .unwrap_or_default();
            keys_to_delete.sort();
            keys_to_delete.dedup();

            if !keys_to_delete.is_empty() {
                let delete_started_at = Instant::now();
                for chunk in keys_to_delete.chunks(1000) {
                    if chunk.is_empty() {
                        continue;
                    }

                    let delete = Delete::builder()
                        .set_objects(Some(
                            chunk
                                .iter()
                                .map(|key| {
                                    ObjectIdentifier::builder()
                                        .key(key)
                                        .build()
                                        .map_err(|error| {
                                            format!(
                                                "Failed to prepare S3 delete object identifier: {error}"
                                            )
                                        })
                                })
                                .collect::<Result<Vec<_>, _>>()?,
                        ))
                        .build()
                        .map_err(|error| {
                            format!("Failed to prepare S3 delete request: {error}")
                        })?;

                    request_counts.increment_delete();
                    client
                        .delete_objects()
                        .bucket(&request.object_store.bucket)
                        .delete(delete)
                        .send()
                        .await
                        .map_err(|error| format!("Failed to delete S3 objects: {error}"))?;
                }
                phase_timings.delete_ms = elapsed_millis_u64(delete_started_at);
            }

            let manifest_write_started_at = Instant::now();
            write_remote_sync_manifest(
                &client,
                &request.object_store,
                &request.remote_prefix,
                &snapshot_manifest_files,
                &snapshot
                    .empty_directories
                    .iter()
                    .cloned()
                    .collect::<Vec<_>>(),
                Some("bundle"),
                existing_manifest_document.as_ref(),
                request_counts.as_ref(),
            )
            .await?;
            phase_timings.manifest_write_ms = elapsed_millis_u64(manifest_write_started_at);
        }

        mark_trusted_managed_prefix_seen(&request.remote_prefix);
        phase_timings.total_primary_path_ms = elapsed_millis_u64(primary_path_started_at);
        phase_timings.total_command_ms = elapsed_millis_u64(command_started_at);

        return Ok(SyncLocalToRemoteResponse {
            ok: true,
            protocol_version: PROTOCOL_VERSION,
            local_fingerprint,
            uploaded_file_count,
            deleted_remote_count,
            created_empty_directory_count,
            request_counts: request_counts.snapshot(),
            phase_timings: Some(phase_timings),
        });
    }

    let remote_listing = list_remote_entries(
        &client,
        &request.object_store,
        &request.remote_prefix,
        request_counts.as_ref(),
    )
    .await?;
    let remote_entries = remote_listing.entries;
    let bundle_entry = remote_listing.bundle_entry;
    let existing_manifest_document = if remote_listing.has_sync_manifest {
        load_remote_sync_manifest_document(
            &client,
            &request.object_store,
            &request.remote_prefix,
            request_counts.as_ref(),
        )
        .await?
    } else {
        None
    };
    let sync_manifest = Arc::new(
        existing_manifest_document
            .as_ref()
            .map(|document| {
                document
                    .files
                    .iter()
                    .filter_map(|(relative_path, entry)| {
                        let normalized = normalize_relative_path(relative_path);
                        if normalized.is_empty() || should_ignore_relative_path(&normalized) {
                            return None;
                        }
                        Some((normalized, entry.clone()))
                    })
                    .collect::<BTreeMap<_, _>>()
            })
            .unwrap_or_default(),
    );
    let remote_entries_by_relative_path = remote_entries
        .iter()
        .cloned()
        .map(|entry| (normalize_relative_path(&entry.relative_path), entry))
        .collect::<BTreeMap<_, _>>();
    let plan = create_local_to_remote_plan(&snapshot, remote_entries);

    let remote_entries_by_relative_path = Arc::new(remote_entries_by_relative_path);

    let client_for_uploads = client.clone();
    let object_store_for_uploads = request.object_store.clone();
    let remote_prefix_for_uploads = request.remote_prefix.clone();
    let request_counts_for_uploads = Arc::clone(&request_counts);
    let inline_upload_threshold_bytes_for_uploads = inline_upload_threshold_bytes;
    let uploaded_candidates = process_with_concurrency(
        plan.upload_candidates.clone(),
        max_concurrency,
        move |candidate| {
            let client = client_for_uploads.clone();
            let object_store = object_store_for_uploads.clone();
            let remote_prefix = remote_prefix_for_uploads.clone();
            let request_counts = Arc::clone(&request_counts_for_uploads);
            let inline_upload_threshold_bytes = inline_upload_threshold_bytes_for_uploads;
            async move {
                let key = build_remote_path(&remote_prefix, &candidate.relative_path);
                upload_local_file(
                    &client,
                    &object_store,
                    &key,
                    &candidate.absolute_path,
                    candidate.size,
                    inline_upload_threshold_bytes,
                    candidate.mtime_ms,
                    request_counts.as_ref(),
                )
                .await
            }
        },
    )
    .await?;

    let client_for_info_checks = client.clone();
    let object_store_for_info_checks = request.object_store.clone();
    let remote_prefix_for_info_checks = request.remote_prefix.clone();
    let remote_entries_for_info_checks = Arc::clone(&remote_entries_by_relative_path);
    let sync_manifest_for_info_checks = Arc::clone(&sync_manifest);
    let request_counts_for_info_checks = Arc::clone(&request_counts);
    let inline_upload_threshold_bytes_for_info_checks = inline_upload_threshold_bytes;
    let info_checked_candidates = process_with_concurrency(
        plan.info_check_candidates.clone(),
        max_concurrency,
        move |candidate| {
            let client = client_for_info_checks.clone();
            let object_store = object_store_for_info_checks.clone();
            let remote_prefix = remote_prefix_for_info_checks.clone();
            let remote_entries = Arc::clone(&remote_entries_for_info_checks);
            let sync_manifest = Arc::clone(&sync_manifest_for_info_checks);
            let request_counts = Arc::clone(&request_counts_for_info_checks);
            let inline_upload_threshold_bytes = inline_upload_threshold_bytes_for_info_checks;
            async move {
                let remote_entry = remote_entries.get(&candidate.relative_path).cloned();
                let should_upload = match remote_entry {
                    None => true,
                    Some(remote_entry) if remote_entry.is_directory => true,
                    Some(remote_entry) => {
                        if let Some(manifest_entry) = sync_manifest.get(&candidate.relative_path) {
                            if manifest_entry.size == candidate.size
                                && manifest_entry.mtime_ms == candidate.mtime_ms
                            {
                                return Ok(false);
                            }
                        }

                        request_counts.increment_head();
                        let head = client
                            .head_object()
                            .bucket(&object_store.bucket)
                            .key(&remote_entry.key)
                            .send()
                            .await;

                        match head {
                            Ok(head) => match parse_object_mtime_ms(head.metadata()) {
                                Some(remote_mtime_ms) => remote_mtime_ms != candidate.mtime_ms,
                                None => head
                                    .last_modified()
                                    .and_then(|value| value.to_millis().ok())
                                    .map(|value| value as i128)
                                    .map(|value| value < candidate.mtime_ms as i128)
                                    .unwrap_or(true),
                            },
                            Err(_) => true,
                        }
                    }
                };

                if !should_upload {
                    return Ok(false);
                }

                let key = build_remote_path(&remote_prefix, &candidate.relative_path);
                upload_local_file(
                    &client,
                    &object_store,
                    &key,
                    &candidate.absolute_path,
                    candidate.size,
                    inline_upload_threshold_bytes,
                    candidate.mtime_ms,
                    request_counts.as_ref(),
                )
                .await
            }
        },
    )
    .await?;

    let deleted_remote_count = plan.keys_to_delete.len();
    let uploaded_file_count = uploaded_candidates
        .into_iter()
        .filter(|uploaded| *uploaded)
        .count()
        + info_checked_candidates
            .into_iter()
            .filter(|uploaded| *uploaded)
            .count();

    let client_for_empty_directories = client.clone();
    let object_store_for_empty_directories = request.object_store.clone();
    let remote_prefix_for_empty_directories = request.remote_prefix.clone();
    let request_counts_for_empty_directories = Arc::clone(&request_counts);
    let created_empty_directory_count = process_with_concurrency(
        plan.empty_directories_to_create.clone(),
        max_concurrency,
        move |relative_path| {
            let client = client_for_empty_directories.clone();
            let object_store = object_store_for_empty_directories.clone();
            let remote_prefix = remote_prefix_for_empty_directories.clone();
            let request_counts = Arc::clone(&request_counts_for_empty_directories);
            async move {
                let key = format!("{}/", build_remote_path(&remote_prefix, &relative_path));
                request_counts.increment_put();
                client
                    .put_object()
                    .bucket(&object_store.bucket)
                    .key(key)
                    .body(ByteStream::from_static(b""))
                    .send()
                    .await
                    .map_err(|error| {
                        format!("Failed to create empty S3 directory marker: {error}")
                    })?;
                Ok(true)
            }
        },
    )
    .await?
    .len();

    let has_mutations =
        uploaded_file_count > 0 || deleted_remote_count > 0 || created_empty_directory_count > 0;

    for chunk in plan.keys_to_delete.chunks(1000) {
        if chunk.is_empty() {
            continue;
        }

        let delete = Delete::builder()
            .set_objects(Some(
                chunk
                    .iter()
                    .map(|key| {
                        ObjectIdentifier::builder()
                            .key(key)
                            .build()
                            .map_err(|error| {
                                format!("Failed to prepare S3 delete object identifier: {error}")
                            })
                    })
                    .collect::<Result<Vec<_>, _>>()?,
            ))
            .build()
            .map_err(|error| format!("Failed to prepare S3 delete request: {error}"))?;

        request_counts.increment_delete();
        client
            .delete_objects()
            .bucket(&request.object_store.bucket)
            .delete(delete)
            .send()
            .await
            .map_err(|error| format!("Failed to delete S3 objects: {error}"))?;
    }

    write_remote_sync_manifest(
        &client,
        &request.object_store,
        &request.remote_prefix,
        &snapshot_manifest_files,
        &snapshot
            .empty_directories
            .iter()
            .cloned()
            .collect::<Vec<_>>(),
        Some("objects"),
        existing_manifest_document.as_ref(),
        request_counts.as_ref(),
    )
    .await?;

    if has_mutations {
        if should_attempt_sync_bundle_for_snapshot(&snapshot, sync_bundle_config) {
            upload_sync_bundle(
                &client,
                &request.object_store,
                &request.remote_prefix,
                &root_dir,
                &snapshot,
                &excludes,
                request_counts.as_ref(),
            )
            .await?;
        } else if let Some(bundle_entry) = bundle_entry {
            delete_remote_object_if_present(
                &client,
                &request.object_store,
                &bundle_entry.key,
                request_counts.as_ref(),
            )
            .await?;
        }
    }

    prune_empty_local_directories(&root_dir).await?;
    phase_timings.total_command_ms = elapsed_millis_u64(command_started_at);
    Ok(SyncLocalToRemoteResponse {
        ok: true,
        protocol_version: PROTOCOL_VERSION,
        local_fingerprint,
        uploaded_file_count,
        deleted_remote_count,
        created_empty_directory_count,
        request_counts: request_counts.snapshot(),
        phase_timings: Some(phase_timings),
    })
}

fn elapsed_millis_u64(started_at: Instant) -> u64 {
    started_at.elapsed().as_millis().min(u128::from(u64::MAX)) as u64
}

async fn sync_local_to_sandbox_http(
    request: SyncLocalToSandboxHttpRequest,
) -> Result<SyncLocalToSandboxHttpResponse, String> {
    let excludes = normalize_exclude_paths(request.exclude_relative_paths);
    let max_concurrency = resolve_max_concurrency(request.max_concurrency);
    let snapshot = collect_snapshot(&PathBuf::from(&request.root_dir), &excludes)?;
    let local_fingerprint = create_fingerprint(&snapshot);
    let plan = create_seed_upload_plan(&snapshot, &request.remote_root_path);
    let empty_directories_to_create = snapshot
        .empty_directories
        .iter()
        .map(|relative_path| build_remote_path(&request.remote_root_path, relative_path))
        .collect::<BTreeSet<_>>();
    let sandbox_client = NativeSandboxHttpClient::new(&request.sandbox)?;

    let root_path = request.remote_root_path.clone();
    let root_directory_exists =
        if let Some(existing_root) = sandbox_client.stat_path(&root_path).await? {
            if existing_root.kind != "directory" {
                sandbox_client.delete_entry(&root_path, true).await?;
                false
            } else {
                true
            }
        } else {
            false
        };
    if !root_directory_exists {
        sandbox_client.create_directory(&root_path).await?;
    }
    let expected_directories = plan.directories.iter().cloned().collect::<BTreeSet<_>>();
    let expected_files = plan
        .files
        .iter()
        .map(|file| file.remote_path.clone())
        .collect::<BTreeSet<_>>();
    let remote_state = prune_unexpected_remote_sandbox_entries(
        &sandbox_client,
        &root_path,
        &expected_directories,
        &expected_files,
    )
    .await?;
    let directories_to_create = empty_directories_to_create
        .iter()
        .filter(|remote_path| !remote_state.existing_directories.contains(*remote_path))
        .cloned()
        .collect::<Vec<_>>();

    let sandbox_client_for_directories = sandbox_client.clone();
    let created_directory_count =
        process_with_concurrency(directories_to_create, max_concurrency, move |remote_path| {
            let sandbox_client = sandbox_client_for_directories.clone();
            async move {
                sandbox_client.create_directory(&remote_path).await?;
                Ok(true)
            }
        })
        .await?
        .len()
            + if root_directory_exists { 0 } else { 1 };

    let sandbox_client_for_uploads = sandbox_client.clone();
    let remote_file_stats = Arc::new(remote_state.existing_file_stats);
    let uploaded_file_count =
        process_with_concurrency(plan.files.clone(), max_concurrency, move |file| {
            let sandbox_client = sandbox_client_for_uploads.clone();
            let remote_file_stats = Arc::clone(&remote_file_stats);
            async move {
                if let Some(remote_stat) = remote_file_stats.get(&file.remote_path) {
                    if sandbox_file_matches(file.size, file.mtime_ms, remote_stat) {
                        return Ok(false);
                    }
                }
                let data = tokio::fs::read(&file.absolute_path)
                    .await
                    .map_err(|error| {
                        format!(
                            "Failed to read local file {} for sandbox upload: {error}",
                            file.absolute_path
                        )
                    })?;
                sandbox_client
                    .upload_file(&file.remote_path, data, file.mtime_ms)
                    .await?;
                Ok(true)
            }
        })
        .await?
        .into_iter()
        .filter(|uploaded| *uploaded)
        .count();

    Ok(SyncLocalToSandboxHttpResponse {
        ok: true,
        protocol_version: PROTOCOL_VERSION,
        local_fingerprint,
        created_directory_count,
        uploaded_file_count,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Cursor;

    fn make_snapshot() -> Snapshot {
        let mut directories = BTreeSet::new();
        directories.insert("foo".to_string());
        directories.insert("foo/nested".to_string());
        directories.insert("keep".to_string());

        Snapshot {
            files: vec![
                FileEntry {
                    relative_path: "foo/a.txt".to_string(),
                    absolute_path: "/workspace/foo/a.txt".to_string(),
                    size: 10,
                    mtime_ms: 1000,
                    mode: 0o644,
                },
                FileEntry {
                    relative_path: "orphan.txt".to_string(),
                    absolute_path: "/workspace/orphan.txt".to_string(),
                    size: 4,
                    mtime_ms: 2000,
                    mode: 0o644,
                },
                FileEntry {
                    relative_path: "keep/child.txt".to_string(),
                    absolute_path: "/workspace/keep/child.txt".to_string(),
                    size: 6,
                    mtime_ms: 3000,
                    mode: 0o644,
                },
            ],
            files_sorted_by_relative_path: false,
            directories,
            empty_directories: BTreeSet::new(),
            ignored_paths: vec!["/workspace/.DS_Store".to_string()],
        }
    }

    #[test]
    fn fingerprint_matches_when_snapshot_files_are_marked_sorted() {
        let mut unsorted_snapshot = make_snapshot();
        unsorted_snapshot.files.reverse();
        unsorted_snapshot.files_sorted_by_relative_path = false;

        let mut sorted_snapshot = make_snapshot();
        sorted_snapshot
            .files
            .sort_by(|left, right| left.relative_path.cmp(&right.relative_path));
        sorted_snapshot.files_sorted_by_relative_path = true;

        assert_eq!(
            create_fingerprint(&unsorted_snapshot),
            create_fingerprint(&sorted_snapshot)
        );
    }

    #[test]
    fn local_to_remote_plan_splits_uploads_and_deletes() {
        let snapshot = make_snapshot();
        let plan = create_local_to_remote_plan(
            &snapshot,
            vec![
                PlanRemoteEntry {
                    relative_path: "foo/a.txt".to_string(),
                    key: "prefix/foo/a.txt".to_string(),
                    size: 10,
                    last_modified_ms: Some(1000),
                    is_directory: false,
                },
                PlanRemoteEntry {
                    relative_path: "unused.txt".to_string(),
                    key: "prefix/unused.txt".to_string(),
                    size: 5,
                    last_modified_ms: Some(1000),
                    is_directory: false,
                },
            ],
        );

        assert_eq!(plan.upload_candidates.len(), 2);
        assert_eq!(plan.upload_candidates[0].relative_path, "keep/child.txt");
        assert_eq!(plan.upload_candidates[1].relative_path, "orphan.txt");
        assert_eq!(plan.info_check_candidates.len(), 1);
        assert_eq!(plan.info_check_candidates[0].relative_path, "foo/a.txt");
        assert_eq!(plan.keys_to_delete, vec!["prefix/unused.txt".to_string()]);
    }

    #[test]
    fn remote_to_local_plan_emits_downloads_and_removals() {
        let snapshot = make_snapshot();
        let plan = create_remote_to_local_plan(
            Path::new("/workspace"),
            &snapshot,
            vec![
                PlanRemoteEntry {
                    relative_path: "foo/a.txt".to_string(),
                    key: "prefix/foo/a.txt".to_string(),
                    size: 10,
                    last_modified_ms: Some(1000),
                    is_directory: false,
                },
                PlanRemoteEntry {
                    relative_path: "foo/b.txt".to_string(),
                    key: "prefix/foo/b.txt".to_string(),
                    size: 8,
                    last_modified_ms: Some(1000),
                    is_directory: false,
                },
            ],
            vec!["keep".to_string()],
        );

        assert_eq!(plan.download_candidates.len(), 1);
        assert_eq!(plan.download_candidates[0].relative_path, "foo/b.txt");
        assert_eq!(plan.info_check_candidates.len(), 1);
        assert_eq!(plan.info_check_candidates[0].relative_path, "foo/a.txt");
        assert!(plan
            .remove_paths
            .contains(&"/workspace/.DS_Store".to_string()));
        assert!(plan
            .remove_paths
            .contains(&"/workspace/orphan.txt".to_string()));
        assert!(plan
            .remove_paths
            .contains(&"/workspace/foo/nested".to_string()));
        assert!(!plan.remove_paths.contains(&"/workspace/keep".to_string()));
        assert!(!plan
            .remove_paths
            .contains(&"/workspace/keep/child.txt".to_string()));
    }

    #[test]
    fn seed_upload_plan_maps_remote_paths_and_orders_parent_directories_first() {
        let snapshot = make_snapshot();
        let plan = create_seed_upload_plan(&snapshot, "/workspace/root/");

        assert_eq!(
            plan.directories,
            vec![
                "/workspace/root/foo".to_string(),
                "/workspace/root/keep".to_string(),
                "/workspace/root/foo/nested".to_string(),
            ]
        );
        assert_eq!(plan.files.len(), 3);
        assert_eq!(plan.files[0].remote_path, "/workspace/root/foo/a.txt");
        assert_eq!(plan.files[1].remote_path, "/workspace/root/keep/child.txt");
        assert_eq!(plan.files[2].remote_path, "/workspace/root/orphan.txt");
        assert_eq!(plan.files[1].mtime_ms, 3000);
    }

    #[test]
    fn build_seed_archive_writes_tar_and_ignores_runtime_junk() {
        let temp = tempfile::tempdir().expect("tempdir");
        let root = temp.path().join("workspace");
        fs::create_dir_all(root.join("src")).expect("src");
        fs::create_dir_all(root.join("empty")).expect("empty");
        fs::create_dir_all(root.join("__pycache__")).expect("pycache");
        fs::write(root.join("src").join("main.txt"), "hello").expect("main");
        fs::write(root.join(".DS_Store"), "junk").expect("ds store");
        fs::write(root.join("__pycache__").join("main.pyc"), "junk").expect("pyc");

        let archive_path = temp.path().join("workspace-seed.tar");
        let response = build_seed_archive(BuildSeedArchiveRequest {
            root_dir: normalize_path(&root),
            archive_path: normalize_path(&archive_path),
        })
        .expect("build seed archive");

        assert_eq!(response.file_count, 1);
        assert_eq!(response.empty_directory_count, 1);
        assert!(response.archive_bytes > 0);

        let archive_file = fs::File::open(&archive_path).expect("archive");
        let mut archive = tar::Archive::new(archive_file);
        let names = archive
            .entries()
            .expect("entries")
            .map(|entry| {
                entry
                    .expect("entry")
                    .path()
                    .expect("path")
                    .to_string_lossy()
                    .to_string()
            })
            .collect::<Vec<_>>();
        let normalized_names = names
            .iter()
            .map(|name| name.trim_end_matches('/').to_string())
            .collect::<Vec<_>>();

        assert!(normalized_names.contains(&"src/main.txt".to_string()));
        assert!(normalized_names.contains(&"empty".to_string()));
        assert!(!names.iter().any(|name| name.contains(".DS_Store")));
        assert!(!names.iter().any(|name| name.contains("__pycache__")));
    }

    #[test]
    fn sync_bundle_from_snapshot_uses_filtered_entries() {
        let temp = tempfile::tempdir().expect("tempdir");
        let root = temp.path().join("workspace");
        fs::create_dir_all(root.join("src")).expect("src");
        fs::create_dir_all(root.join("empty")).expect("empty");
        fs::create_dir_all(root.join("__pycache__")).expect("pycache");
        fs::write(root.join("src").join("main.txt"), "hello").expect("main");
        fs::write(root.join(".DS_Store"), "junk").expect("ds store");
        fs::write(root.join("__pycache__").join("main.pyc"), "junk").expect("pyc");

        let snapshot = collect_snapshot(&root, &[]).expect("snapshot");
        let mut files = snapshot.files.clone();
        files.sort_by(|left, right| left.relative_path.cmp(&right.relative_path));
        let empty_directories = snapshot
            .empty_directories
            .iter()
            .cloned()
            .collect::<Vec<_>>();
        let bundle_bytes =
            build_local_sync_bundle_to_memory_blocking(&files, &empty_directories).expect("bundle");

        let mut archive = tar::Archive::new(Cursor::new(bundle_bytes));
        let names = archive
            .entries()
            .expect("entries")
            .map(|entry| {
                entry
                    .expect("entry")
                    .path()
                    .expect("path")
                    .to_string_lossy()
                    .to_string()
            })
            .collect::<Vec<_>>();
        let normalized_names = names
            .iter()
            .map(|name| name.trim_end_matches('/').to_string())
            .collect::<Vec<_>>();

        assert!(normalized_names.contains(&"src/main.txt".to_string()));
        assert!(normalized_names.contains(&"empty".to_string()));
        assert!(!names.iter().any(|name| name.contains(".DS_Store")));
        assert!(!names.iter().any(|name| name.contains("__pycache__")));
    }

    #[test]
    fn build_remote_path_trims_duplicate_separators() {
        assert_eq!(
            build_remote_path("/seed/workspace/", "/nested/file.txt"),
            "/seed/workspace/nested/file.txt"
        );
        assert_eq!(build_remote_path("", "/nested/file.txt"), "nested/file.txt");
        assert_eq!(build_remote_path("/seed/workspace/", ""), "/seed/workspace");
    }

    #[test]
    fn ignore_internal_sync_sidecars() {
        assert!(should_ignore_relative_path(".oah-sync-manifest.json"));
        assert!(should_ignore_relative_path(".oah-sync-bundle.tar"));
        assert!(!should_ignore_relative_path("README.md"));
    }

    #[test]
    fn sandbox_file_match_tolerates_sub_millisecond_mtime_drift() {
        let remote = NativeSandboxHttpFileStat {
            kind: "file".to_string(),
            size: 12,
            mtime_ms: 1_234.6,
        };

        assert!(sandbox_file_matches(12, 1_234, &remote));
        assert!(!sandbox_file_matches(11, 1_234, &remote));
        assert!(!sandbox_file_matches(12, 1_236, &remote));
    }

    #[test]
    fn remote_sandbox_entry_keep_logic_respects_type_mismatches() {
        let expected_directories =
            BTreeSet::from(["/workspace".to_string(), "/workspace/nested".to_string()]);
        let expected_files = BTreeSet::from(["/workspace/README.md".to_string()]);

        assert!(should_keep_remote_sandbox_entry(
            &NativeSandboxHttpEntry {
                path: "/workspace/nested".to_string(),
                entry_type: "directory".to_string(),
                size_bytes: None,
                updated_at: None,
            },
            &expected_directories,
            &expected_files,
        ));
        assert!(should_keep_remote_sandbox_entry(
            &NativeSandboxHttpEntry {
                path: "/workspace/README.md".to_string(),
                entry_type: "file".to_string(),
                size_bytes: Some(12),
                updated_at: Some("2026-04-24T00:00:00.000Z".to_string()),
            },
            &expected_directories,
            &expected_files,
        ));
        assert!(!should_keep_remote_sandbox_entry(
            &NativeSandboxHttpEntry {
                path: "/workspace/nested".to_string(),
                entry_type: "file".to_string(),
                size_bytes: Some(12),
                updated_at: Some("2026-04-24T00:00:00.000Z".to_string()),
            },
            &expected_directories,
            &expected_files,
        ));
        assert!(!should_keep_remote_sandbox_entry(
            &NativeSandboxHttpEntry {
                path: "/workspace/stale.txt".to_string(),
                entry_type: "file".to_string(),
                size_bytes: Some(12),
                updated_at: Some("2026-04-24T00:00:00.000Z".to_string()),
            },
            &expected_directories,
            &expected_files,
        ));
    }

    #[test]
    fn sandbox_entry_file_stat_uses_listing_metadata() {
        let entry = NativeSandboxHttpEntry {
            path: "/workspace/README.md".to_string(),
            entry_type: "file".to_string(),
            size_bytes: Some(12),
            updated_at: Some("2026-04-24T00:00:00.500Z".to_string()),
        };

        let stat = sandbox_entry_file_stat(&entry).expect("expected file stat");
        assert_eq!(stat.kind, "file");
        assert_eq!(stat.size, 12);
        assert!(sandbox_mtime_matches(1_776_988_800_500, stat.mtime_ms));
    }

    #[test]
    fn worker_request_executes_version_command_and_includes_request_id() {
        let mut runtime = None;
        let response = handle_worker_request(
            WorkerRequest {
                request_id: "req_1".to_string(),
                command: "version".to_string(),
                payload: None,
                sent_at_ms: None,
            },
            &mut runtime,
        );

        assert_eq!(response.get("ok").and_then(Value::as_bool), Some(true));
        assert_eq!(
            response.get("requestId").and_then(Value::as_str),
            Some("req_1")
        );
        assert_eq!(
            response.get("name").and_then(Value::as_str),
            Some(BINARY_NAME)
        );
    }

    #[test]
    fn worker_request_reports_unknown_command_error() {
        let mut runtime = None;
        let response = handle_worker_request(
            WorkerRequest {
                request_id: "req_2".to_string(),
                command: "unknown".to_string(),
                payload: None,
                sent_at_ms: None,
            },
            &mut runtime,
        );

        assert_eq!(response.get("ok").and_then(Value::as_bool), Some(false));
        assert_eq!(
            response.get("requestId").and_then(Value::as_str),
            Some("req_2")
        );
        assert!(response
            .get("message")
            .and_then(Value::as_str)
            .is_some_and(|message| message.contains("Unknown command")));
    }
}
