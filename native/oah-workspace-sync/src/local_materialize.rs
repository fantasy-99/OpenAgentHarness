use std::collections::BTreeSet;
use std::fs;
use std::io;
use std::io::{BufReader, BufWriter, Write};
use std::path::{Component, Path, PathBuf};
use std::thread;
use std::time::Instant;

use filetime::{set_file_handle_times, FileTime};
use serde::{Deserialize, Serialize};

use crate::elapsed_millis_u64;
use crate::path_rules::normalize_exclude_paths;
use crate::protocol::PROTOCOL_VERSION;
use crate::snapshot::{
    collect_snapshot, collect_snapshot_with_options, create_fingerprint, FileEntry, SnapshotOptions,
};

const PARALLEL_LOCAL_MATERIALIZE_ENV: &str = "OAH_NATIVE_WORKSPACE_SYNC_PARALLEL_LOCAL_MATERIALIZE";
const PARALLEL_LOCAL_MATERIALIZE_THREADS_ENV: &str =
    "OAH_NATIVE_WORKSPACE_SYNC_PARALLEL_LOCAL_MATERIALIZE_THREADS";
const PARALLEL_LOCAL_MATERIALIZE_MIN_FILES: usize = 256;
const PARALLEL_LOCAL_MATERIALIZE_MAX_THREADS: usize = 8;

#[derive(Clone, Copy, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum LocalMaterializeMode {
    Create,
    Replace,
    Merge,
}

impl Default for LocalMaterializeMode {
    fn default() -> Self {
        Self::Create
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct LocalMaterializeRequest {
    pub(crate) source_root_dir: String,
    pub(crate) target_root_dir: String,
    #[serde(default)]
    pub(crate) exclude_relative_paths: Vec<String>,
    #[serde(default)]
    pub(crate) mode: LocalMaterializeMode,
    #[serde(default = "default_true")]
    pub(crate) preserve_timestamps: bool,
    #[serde(default)]
    pub(crate) apply_default_ignores: bool,
    #[serde(default = "default_true")]
    pub(crate) compute_target_fingerprint: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct LocalMaterializeTimings {
    pub(crate) scan_ms: u64,
    pub(crate) target_prepare_ms: u64,
    pub(crate) mkdir_ms: u64,
    pub(crate) copy_ms: u64,
    pub(crate) fingerprint_ms: u64,
    pub(crate) total_command_ms: u64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct LocalMaterializeResponse {
    pub(crate) ok: bool,
    pub(crate) protocol_version: u32,
    pub(crate) fingerprint: String,
    pub(crate) target_fingerprint_verified: bool,
    pub(crate) copied_file_count: usize,
    pub(crate) skipped_unchanged_file_count: usize,
    pub(crate) created_directory_count: usize,
    pub(crate) removed_target: bool,
    pub(crate) total_bytes: u64,
    pub(crate) phase_timings: LocalMaterializeTimings,
}

pub(crate) fn materialize_local_tree(
    request: LocalMaterializeRequest,
) -> Result<LocalMaterializeResponse, String> {
    let command_started_at = Instant::now();
    let source_root = PathBuf::from(&request.source_root_dir);
    let target_root = PathBuf::from(&request.target_root_dir);
    validate_materialize_roots(&source_root, &target_root, request.mode)?;

    let excludes = normalize_exclude_paths(request.exclude_relative_paths);
    let scan_started_at = Instant::now();
    let source_snapshot = if request.apply_default_ignores {
        collect_snapshot(&source_root, &excludes)?
    } else {
        collect_snapshot_with_options(
            &source_root,
            &excludes,
            SnapshotOptions {
                ignore_default_junk: false,
            },
        )?
    };
    let scan_ms = elapsed_millis_u64(scan_started_at);

    let target_prepare_started_at = Instant::now();
    let removed_target = prepare_target_root(&target_root, request.mode)?;
    let target_prepare_ms = elapsed_millis_u64(target_prepare_started_at);

    let mkdir_started_at = Instant::now();
    let created_directory_count = materialize_directories(
        &target_root,
        &source_snapshot.directories,
        &source_snapshot.empty_directories,
    )?;
    let mkdir_ms = elapsed_millis_u64(mkdir_started_at);

    let copy_started_at = Instant::now();
    let copy_outcome = materialize_files(
        &target_root,
        &source_snapshot.files,
        request.preserve_timestamps,
        if matches!(request.mode, LocalMaterializeMode::Merge) {
            MaterializeFileMode::MergeTarget
        } else {
            MaterializeFileMode::EmptyTarget
        },
    )?;
    let copy_ms = elapsed_millis_u64(copy_started_at);

    let fingerprint_started_at = Instant::now();
    let (fingerprint, target_fingerprint_verified) = if request.compute_target_fingerprint {
        let target_snapshot = if request.apply_default_ignores {
            collect_snapshot(&target_root, &excludes)?
        } else {
            collect_snapshot_with_options(
                &target_root,
                &excludes,
                SnapshotOptions {
                    ignore_default_junk: false,
                },
            )?
        };
        (create_fingerprint(&target_snapshot), true)
    } else {
        let source_fingerprint = create_fingerprint(&source_snapshot);
        (source_fingerprint, false)
    };
    let fingerprint_ms = elapsed_millis_u64(fingerprint_started_at);

    Ok(LocalMaterializeResponse {
        ok: true,
        protocol_version: PROTOCOL_VERSION,
        fingerprint,
        target_fingerprint_verified,
        copied_file_count: copy_outcome.copied_file_count,
        skipped_unchanged_file_count: copy_outcome.skipped_unchanged_file_count,
        created_directory_count,
        removed_target,
        total_bytes: copy_outcome.total_bytes,
        phase_timings: LocalMaterializeTimings {
            scan_ms,
            target_prepare_ms,
            mkdir_ms,
            copy_ms,
            fingerprint_ms,
            total_command_ms: elapsed_millis_u64(command_started_at),
        },
    })
}

struct CopyOutcome {
    copied_file_count: usize,
    skipped_unchanged_file_count: usize,
    total_bytes: u64,
}

#[derive(Clone, Copy)]
enum MaterializeFileMode {
    EmptyTarget,
    MergeTarget,
}

fn default_true() -> bool {
    true
}

fn validate_materialize_roots(
    source_root: &Path,
    target_root: &Path,
    mode: LocalMaterializeMode,
) -> Result<(), String> {
    let source_metadata = fs::metadata(source_root).map_err(|error| {
        format!(
            "Failed to stat local materialize source {}: {error}",
            source_root.display()
        )
    })?;
    if !source_metadata.is_dir() {
        return Err(format!(
            "Local materialize source is not a directory: {}",
            source_root.display()
        ));
    }

    if normalized_absolute_path(target_root).parent().is_none() {
        return Err(format!(
            "Refusing to materialize into filesystem root: {}",
            target_root.display()
        ));
    }

    let source_canonical = fs::canonicalize(source_root).map_err(|error| {
        format!(
            "Failed to canonicalize local materialize source {}: {error}",
            source_root.display()
        )
    })?;
    let target_identity = target_identity_path(target_root)?;

    if target_identity.starts_with(&source_canonical)
        || source_canonical.starts_with(&target_identity)
    {
        return Err(format!(
            "Refusing to materialize between overlapping roots: source={}, target={}",
            source_root.display(),
            target_root.display()
        ));
    }

    if matches!(mode, LocalMaterializeMode::Create) && target_root.exists() {
        return Err(format!(
            "Local materialize target already exists in create mode: {}",
            target_root.display()
        ));
    }

    Ok(())
}

fn target_identity_path(path: &Path) -> Result<PathBuf, String> {
    if path.exists() {
        return fs::canonicalize(path)
            .map_err(|error| format!("Failed to canonicalize target {}: {error}", path.display()));
    }

    let mut cursor = path;
    let mut missing_components = Vec::new();
    while let Some(parent) = cursor.parent() {
        if parent.exists() {
            if let Some(name) = cursor.file_name() {
                missing_components.push(name.to_owned());
            }
            let mut resolved = fs::canonicalize(parent).map_err(|error| {
                format!(
                    "Failed to canonicalize target parent {}: {error}",
                    parent.display()
                )
            })?;
            for component in missing_components.iter().rev() {
                resolved.push(component);
            }
            return Ok(resolved);
        }
        if let Some(name) = cursor.file_name() {
            missing_components.push(name.to_owned());
        }
        cursor = parent;
    }

    Ok(normalized_absolute_path(path))
}

fn normalized_absolute_path(path: &Path) -> PathBuf {
    let mut absolute = if path.is_absolute() {
        PathBuf::new()
    } else {
        std::env::current_dir().unwrap_or_else(|_| PathBuf::from("."))
    };

    for component in path.components() {
        match component {
            Component::CurDir => {}
            Component::ParentDir => {
                absolute.pop();
            }
            Component::RootDir | Component::Prefix(_) | Component::Normal(_) => {
                absolute.push(component.as_os_str());
            }
        }
    }

    absolute
}

fn prepare_target_root(target_root: &Path, mode: LocalMaterializeMode) -> Result<bool, String> {
    match mode {
        LocalMaterializeMode::Create => {
            fs::create_dir_all(target_root).map_err(|error| {
                format!(
                    "Failed to create local materialize target {}: {error}",
                    target_root.display()
                )
            })?;
            Ok(false)
        }
        LocalMaterializeMode::Replace => {
            let existed = match fs::metadata(target_root) {
                Ok(metadata) if metadata.is_dir() => {
                    fs::remove_dir_all(target_root).map_err(|error| {
                        format!(
                            "Failed to replace local materialize target directory {}: {error}",
                            target_root.display()
                        )
                    })?;
                    true
                }
                Ok(_) => {
                    fs::remove_file(target_root).map_err(|error| {
                        format!(
                            "Failed to replace local materialize target file {}: {error}",
                            target_root.display()
                        )
                    })?;
                    true
                }
                Err(error) if error.kind() == io::ErrorKind::NotFound => false,
                Err(error) => {
                    return Err(format!(
                        "Failed to stat local materialize target {}: {error}",
                        target_root.display()
                    ));
                }
            };
            fs::create_dir_all(target_root).map_err(|error| {
                format!(
                    "Failed to create local materialize target {}: {error}",
                    target_root.display()
                )
            })?;
            Ok(existed)
        }
        LocalMaterializeMode::Merge => {
            ensure_directory(target_root)?;
            Ok(false)
        }
    }
}

fn materialize_directories(
    target_root: &Path,
    directories: &BTreeSet<String>,
    empty_directories: &BTreeSet<String>,
) -> Result<usize, String> {
    let mut created_count = 0usize;
    for relative_directory in directories.iter().chain(empty_directories.iter()) {
        if ensure_directory(&target_root.join(relative_directory))? {
            created_count += 1;
        }
    }
    Ok(created_count)
}

fn materialize_files(
    target_root: &Path,
    files: &[FileEntry],
    preserve_timestamps: bool,
    mode: MaterializeFileMode,
) -> Result<CopyOutcome, String> {
    if matches!(mode, MaterializeFileMode::EmptyTarget) {
        if let Some(thread_count) = resolve_parallel_local_materialize_threads(files.len()) {
            return materialize_files_parallel_empty_target(
                target_root,
                files,
                preserve_timestamps,
                thread_count,
            );
        }
    }

    let mut outcome = CopyOutcome {
        copied_file_count: 0,
        skipped_unchanged_file_count: 0,
        total_bytes: 0,
    };

    for file in files {
        let target_path = target_root.join(&file.relative_path);
        if matches!(mode, MaterializeFileMode::MergeTarget)
            && should_skip_unchanged_file(&target_path, file, preserve_timestamps)?
        {
            outcome.skipped_unchanged_file_count += 1;
            continue;
        }

        match mode {
            MaterializeFileMode::EmptyTarget => {
                copy_file_to_empty_target(&target_path, file, preserve_timestamps)?
            }
            MaterializeFileMode::MergeTarget => {
                copy_file_to_merge_target(&target_path, file, preserve_timestamps)?
            }
        }
        outcome.copied_file_count += 1;
        outcome.total_bytes = outcome.total_bytes.saturating_add(file.size);
    }

    Ok(outcome)
}

fn materialize_files_parallel_empty_target(
    target_root: &Path,
    files: &[FileEntry],
    preserve_timestamps: bool,
    thread_count: usize,
) -> Result<CopyOutcome, String> {
    let chunk_size = files.len().div_ceil(thread_count).max(1);
    let outcomes = thread::scope(|scope| {
        let mut handles = Vec::new();
        for chunk in files.chunks(chunk_size) {
            let target_root = target_root.to_path_buf();
            handles.push(scope.spawn(move || {
                let mut outcome = CopyOutcome {
                    copied_file_count: 0,
                    skipped_unchanged_file_count: 0,
                    total_bytes: 0,
                };
                for file in chunk {
                    let target_path = target_root.join(&file.relative_path);
                    copy_file_to_empty_target(&target_path, file, preserve_timestamps)?;
                    outcome.copied_file_count += 1;
                    outcome.total_bytes = outcome.total_bytes.saturating_add(file.size);
                }
                Ok::<CopyOutcome, String>(outcome)
            }));
        }

        let mut outcomes = Vec::with_capacity(handles.len());
        for handle in handles {
            outcomes.push(
                handle
                    .join()
                    .map_err(|_| "Parallel local materialize worker panicked.".to_string())??,
            );
        }
        Ok::<Vec<CopyOutcome>, String>(outcomes)
    })?;

    Ok(outcomes.into_iter().fold(
        CopyOutcome {
            copied_file_count: 0,
            skipped_unchanged_file_count: 0,
            total_bytes: 0,
        },
        |mut total, outcome| {
            total.copied_file_count += outcome.copied_file_count;
            total.skipped_unchanged_file_count += outcome.skipped_unchanged_file_count;
            total.total_bytes = total.total_bytes.saturating_add(outcome.total_bytes);
            total
        },
    ))
}

fn copy_file_to_empty_target(
    target_path: &Path,
    source_file: &FileEntry,
    preserve_timestamps: bool,
) -> Result<(), String> {
    copy_file_body_and_metadata(target_path, source_file, preserve_timestamps)
}

fn copy_file_to_merge_target(
    target_path: &Path,
    source_file: &FileEntry,
    preserve_timestamps: bool,
) -> Result<(), String> {
    prepare_file_target(target_path)?;
    copy_file_body_and_metadata(target_path, source_file, preserve_timestamps)
}

fn copy_file_body_and_metadata(
    target_path: &Path,
    source_file: &FileEntry,
    preserve_timestamps: bool,
) -> Result<(), String> {
    let target = fs::OpenOptions::new()
        .create(true)
        .truncate(true)
        .write(true)
        .open(target_path)
        .map_err(|error| {
            format!(
                "Failed to create local materialize target file {}: {error}",
                target_path.display()
            )
        })?;

    let source = fs::File::open(&source_file.absolute_path).map_err(|error| {
        format!(
            "Failed to open local materialize source file {}: {error}",
            source_file.absolute_path
        )
    })?;
    let mut reader = BufReader::new(source);
    let mut writer = BufWriter::new(target);
    io::copy(&mut reader, &mut writer).map_err(|error| {
        format!(
            "Failed to copy local materialize file {} to {}: {error}",
            source_file.absolute_path,
            target_path.display()
        )
    })?;
    writer.flush().map_err(|error| {
        format!(
            "Failed to flush local materialize file {}: {error}",
            target_path.display()
        )
    })?;
    let target = writer.into_inner().map_err(|error| {
        format!(
            "Failed to finish local materialize file {}: {error}",
            target_path.display()
        )
    })?;
    finish_file_target(&target, target_path, source_file, preserve_timestamps)?;
    Ok(())
}

fn ensure_directory(target_path: &Path) -> Result<bool, String> {
    match fs::metadata(target_path) {
        Ok(metadata) if metadata.is_dir() => Ok(false),
        Ok(_) => {
            remove_path(target_path)?;
            fs::create_dir_all(target_path).map_err(|error| {
                format!(
                    "Failed to create local materialize directory {}: {error}",
                    target_path.display()
                )
            })?;
            Ok(true)
        }
        Err(error) if error.kind() == io::ErrorKind::NotFound => {
            fs::create_dir_all(target_path).map_err(|error| {
                format!(
                    "Failed to create local materialize directory {}: {error}",
                    target_path.display()
                )
            })?;
            Ok(true)
        }
        Err(error) => Err(format!(
            "Failed to stat local materialize directory {}: {error}",
            target_path.display()
        )),
    }
}

fn prepare_file_target(target_path: &Path) -> Result<(), String> {
    if let Some(parent) = target_path.parent() {
        fs::create_dir_all(parent).map_err(|error| {
            format!(
                "Failed to create local materialize parent directory {}: {error}",
                parent.display()
            )
        })?;
    }

    match fs::metadata(target_path) {
        Ok(metadata) if metadata.is_file() => Ok(()),
        Ok(_) => remove_path(target_path),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(format!(
            "Failed to stat local materialize file target {}: {error}",
            target_path.display()
        )),
    }
}

fn remove_path(target_path: &Path) -> Result<(), String> {
    let metadata = fs::metadata(target_path).map_err(|error| {
        format!(
            "Failed to stat local materialize path {} before removal: {error}",
            target_path.display()
        )
    })?;
    if metadata.is_dir() {
        fs::remove_dir_all(target_path).map_err(|error| {
            format!(
                "Failed to remove local materialize directory {}: {error}",
                target_path.display()
            )
        })
    } else {
        fs::remove_file(target_path).map_err(|error| {
            format!(
                "Failed to remove local materialize file {}: {error}",
                target_path.display()
            )
        })
    }
}

fn should_skip_unchanged_file(
    target_path: &Path,
    source_file: &FileEntry,
    preserve_timestamps: bool,
) -> Result<bool, String> {
    if !preserve_timestamps {
        return Ok(false);
    }

    let metadata = match fs::metadata(target_path) {
        Ok(metadata) if metadata.is_file() => metadata,
        Ok(_) => return Ok(false),
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(false),
        Err(error) => {
            return Err(format!(
                "Failed to stat local materialize target file {}: {error}",
                target_path.display()
            ));
        }
    };

    if metadata.len() != source_file.size {
        return Ok(false);
    }
    if !mtime_matches(metadata_mtime_ms(&metadata), source_file.mtime_ms) {
        return Ok(false);
    }

    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        if metadata.permissions().mode() & 0o7777 != source_file.mode & 0o7777 {
            return Ok(false);
        }
    }

    Ok(true)
}

fn finish_file_target(
    target_file: &fs::File,
    target_path: &Path,
    source_file: &FileEntry,
    preserve_timestamps: bool,
) -> Result<(), String> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mode = source_file.mode & 0o7777;
        if mode != 0 {
            target_file
                .set_permissions(fs::Permissions::from_mode(mode))
                .map_err(|error| {
                    format!(
                        "Failed to set local materialize file permissions on {}: {error}",
                        target_path.display()
                    )
                })?;
        }
    }

    if preserve_timestamps {
        set_file_handle_times(
            target_file,
            None,
            Some(file_time_from_mtime_ms(source_file.mtime_ms)),
        )
        .map_err(|error| {
            format!(
                "Failed to preserve mtime for local materialize file {}: {error}",
                target_path.display()
            )
        })?;
    }

    Ok(())
}

fn metadata_mtime_ms(metadata: &fs::Metadata) -> u128 {
    metadata
        .modified()
        .ok()
        .and_then(|modified_at| modified_at.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|duration| duration.as_millis())
        .unwrap_or_default()
}

fn mtime_matches(left: u128, right: u128) -> bool {
    left.abs_diff(right) <= 1
}

fn file_time_from_mtime_ms(value: u128) -> FileTime {
    let seconds = (value / 1000).min(i64::MAX as u128) as i64;
    let nanos = ((value % 1000) * 1_000_000) as u32;
    FileTime::from_unix_time(seconds, nanos)
}

fn resolve_parallel_local_materialize_threads(file_count: usize) -> Option<usize> {
    if file_count < PARALLEL_LOCAL_MATERIALIZE_MIN_FILES {
        return None;
    }
    if !read_bool_env(PARALLEL_LOCAL_MATERIALIZE_ENV).unwrap_or(false) {
        return None;
    }

    let default_threads = thread::available_parallelism()
        .map(usize::from)
        .unwrap_or(1)
        .min(PARALLEL_LOCAL_MATERIALIZE_MAX_THREADS);
    let thread_count = read_usize_env(PARALLEL_LOCAL_MATERIALIZE_THREADS_ENV)
        .unwrap_or(default_threads)
        .clamp(1, PARALLEL_LOCAL_MATERIALIZE_MAX_THREADS)
        .min(file_count);
    (thread_count > 1).then_some(thread_count)
}

fn read_bool_env(name: &str) -> Option<bool> {
    match std::env::var(name)
        .ok()?
        .trim()
        .to_ascii_lowercase()
        .as_str()
    {
        "1" | "true" | "yes" | "on" => Some(true),
        "0" | "false" | "no" | "off" => Some(false),
        _ => None,
    }
}

fn read_usize_env(name: &str) -> Option<usize> {
    std::env::var(name).ok()?.trim().parse::<usize>().ok()
}
