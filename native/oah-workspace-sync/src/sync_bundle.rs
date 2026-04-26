use std::env;
use std::fs;
use std::io::{self, Cursor, Read, Write};
use std::path::{Path, PathBuf};
use std::process::Command as ProcessCommand;

use crate::path_rules::{INTERNAL_SYNC_BUNDLE_RELATIVE_PATH, INTERNAL_SYNC_MANIFEST_RELATIVE_PATH};
use crate::snapshot::{FileEntry, Snapshot};
use crate::sync_bundle_ustar::{
    try_unpack_ustar_bundle_bytes_blocking, try_unpack_ustar_bundle_reader_blocking,
};
use crate::sync_bundle_ustar_writer::write_snapshot_ustar_archive;

const DEFAULT_IN_MEMORY_SYNC_BUNDLE_MIN_SOURCE_BYTES: u64 = 256 * 1024;
const DEFAULT_IN_MEMORY_SYNC_BUNDLE_MAX_SOURCE_BYTES: u64 = 8 * 1024 * 1024;
const DEFAULT_IN_MEMORY_SYNC_BUNDLE_EXTRACT_MAX_BYTES: u64 = 16 * 1024 * 1024;
const IN_MEMORY_SYNC_BUNDLE_MIN_SOURCE_BYTES_ENV: &str =
    "OAH_NATIVE_WORKSPACE_SYNC_IN_MEMORY_BUNDLE_MIN_SOURCE_BYTES";
const IN_MEMORY_SYNC_BUNDLE_MAX_SOURCE_BYTES_ENV: &str =
    "OAH_NATIVE_WORKSPACE_SYNC_IN_MEMORY_BUNDLE_MAX_SOURCE_BYTES";
const IN_MEMORY_SYNC_BUNDLE_EXTRACT_MAX_BYTES_ENV: &str =
    "OAH_NATIVE_WORKSPACE_SYNC_IN_MEMORY_BUNDLE_EXTRACT_MAX_BYTES";
const RUST_SYNC_BUNDLE_WRITER_ENV: &str = "OAH_NATIVE_WORKSPACE_SYNC_RUST_BUNDLE_WRITER";
const RUST_SYNC_BUNDLE_EXTRACTOR_ENV: &str = "OAH_NATIVE_WORKSPACE_SYNC_RUST_BUNDLE_EXTRACTOR";

pub(super) enum BuiltSyncBundle {
    TempPath(tempfile::TempPath),
    Bytes(Vec<u8>),
}

#[derive(Clone, Copy)]
struct InMemorySyncBundleSourceByteRange {
    min: u64,
    max: u64,
}

#[derive(Clone, Default)]
pub(crate) struct SyncBundleExtractTimings {
    pub(super) mkdir_us: u64,
    pub(super) replace_us: u64,
    pub(super) file_create_us: u64,
    pub(super) file_write_us: u64,
    pub(super) file_mtime_us: u64,
    pub(super) chmod_us: u64,
    pub(super) target_check_us: u64,
    pub(super) file_count: u64,
    pub(super) directory_count: u64,
}

pub(super) struct SyncBundleExtractOutcome {
    pub(super) extractor: &'static str,
    pub(super) timings: SyncBundleExtractTimings,
}

pub(super) fn write_snapshot_tar_archive<W: Write>(
    writer: W,
    file_entries: &[FileEntry],
    empty_directories: &[String],
) -> io::Result<W> {
    let mut builder = tar::Builder::new(writer);
    builder.mode(tar::HeaderMode::Deterministic);

    for file in file_entries {
        let mut source = fs::File::open(&file.absolute_path)?;
        let mut header = tar::Header::new_gnu();
        header.set_entry_type(tar::EntryType::Regular);
        header.set_size(file.size);
        header.set_mode(file.mode);
        header.set_mtime((file.mtime_ms / 1000).min(u128::from(u64::MAX)) as u64);
        header.set_cksum();
        builder.append_data(&mut header, Path::new(&file.relative_path), &mut source)?;
    }

    for relative_path in empty_directories {
        let mut header = tar::Header::new_gnu();
        header.set_entry_type(tar::EntryType::Directory);
        header.set_size(0);
        header.set_mode(0o755);
        header.set_mtime(0);
        header.set_cksum();
        builder.append_data(&mut header, Path::new(relative_path), io::empty())?;
    }

    builder.into_inner()
}

pub(super) fn build_local_sync_bundle_to_memory_blocking(
    file_entries: &[FileEntry],
    empty_directories: &[String],
) -> Result<Vec<u8>, String> {
    write_snapshot_ustar_archive(Vec::new(), file_entries, empty_directories)
        .map_err(|error| format!("Failed to build in-memory sync bundle archive: {error}"))
}

pub(super) fn collect_bundle_relative_paths(snapshot: &Snapshot) -> Vec<String> {
    let mut relative_paths = snapshot
        .files
        .iter()
        .map(|file| file.relative_path.clone())
        .chain(snapshot.empty_directories.iter().cloned())
        .collect::<Vec<_>>();
    relative_paths.sort();
    relative_paths
}

pub(super) async fn build_local_sync_bundle(
    root_dir: &Path,
    snapshot: &Snapshot,
    excludes: &[String],
) -> Result<BuiltSyncBundle, String> {
    let root_dir_buf = root_dir.to_path_buf();
    let relative_paths = collect_bundle_relative_paths(snapshot);
    if excludes.is_empty() {
        let can_use_root_tar_fast_path = snapshot.ignored_paths.is_empty();
        let snapshot_total_bytes = snapshot.files.iter().map(|file| file.size).sum::<u64>();
        if should_build_sync_bundle_in_memory(snapshot_total_bytes) {
            if should_use_rust_sync_bundle_writer() {
                let file_entries = snapshot.files.clone();
                let file_entries_sorted = snapshot.files_sorted_by_relative_path;
                let empty_directories = snapshot
                    .empty_directories
                    .iter()
                    .cloned()
                    .collect::<Vec<_>>();
                if let Ok(bundle_bytes) = tokio::task::spawn_blocking(move || {
                    let mut file_entries = file_entries;
                    if !file_entries_sorted {
                        file_entries
                            .sort_by(|left, right| left.relative_path.cmp(&right.relative_path));
                    }
                    build_local_sync_bundle_to_memory_blocking(&file_entries, &empty_directories)
                })
                .await
                .map_err(|error| format!("Sync bundle worker task failed: {error}"))?
                {
                    return Ok(BuiltSyncBundle::Bytes(bundle_bytes));
                }
            }

            if can_use_root_tar_fast_path {
                let root_dir_for_in_memory_fast_path = root_dir_buf.clone();
                if let Some(bundle_bytes) = tokio::task::spawn_blocking(move || {
                    try_build_local_sync_bundle_root_with_tar_to_memory_blocking(
                        &root_dir_for_in_memory_fast_path,
                    )
                })
                .await
                .map_err(|error| format!("Sync bundle worker task failed: {error}"))??
                {
                    return Ok(BuiltSyncBundle::Bytes(bundle_bytes));
                }
            } else {
                let root_dir_for_in_memory_fast_path = root_dir_buf.clone();
                let relative_paths_for_in_memory_fast_path = relative_paths.clone();
                if let Some(bundle_bytes) = tokio::task::spawn_blocking(move || {
                    try_build_local_sync_bundle_with_tar_to_memory_blocking(
                        &root_dir_for_in_memory_fast_path,
                        &relative_paths_for_in_memory_fast_path,
                    )
                })
                .await
                .map_err(|error| format!("Sync bundle worker task failed: {error}"))??
                {
                    return Ok(BuiltSyncBundle::Bytes(bundle_bytes));
                }
            }
        }

        let root_dir_for_fast_path = root_dir_buf.clone();
        if can_use_root_tar_fast_path {
            if let Some(bundle_path) = tokio::task::spawn_blocking(move || {
                try_build_local_sync_bundle_root_with_tar_blocking(&root_dir_for_fast_path)
            })
            .await
            .map_err(|error| format!("Sync bundle worker task failed: {error}"))??
            {
                return Ok(BuiltSyncBundle::TempPath(bundle_path));
            }
        } else {
            let relative_paths_for_fast_path = relative_paths.clone();
            if let Some(bundle_path) = tokio::task::spawn_blocking(move || {
                try_build_local_sync_bundle_with_tar_blocking(
                    &root_dir_for_fast_path,
                    &relative_paths_for_fast_path,
                )
            })
            .await
            .map_err(|error| format!("Sync bundle worker task failed: {error}"))??
            {
                return Ok(BuiltSyncBundle::TempPath(bundle_path));
            }
        }
    }

    let file_entries_input = snapshot.files.iter().cloned().collect::<Vec<_>>();
    let file_entries_input_sorted = snapshot.files_sorted_by_relative_path;
    let empty_directory_relative_paths = snapshot
        .empty_directories
        .iter()
        .cloned()
        .collect::<Vec<_>>();

    tokio::task::spawn_blocking(move || {
        if let Some(bundle_path) =
            try_build_local_sync_bundle_with_tar_blocking(&root_dir_buf, &relative_paths)?
        {
            return Ok(BuiltSyncBundle::TempPath(bundle_path));
        }

        let mut file_entries = file_entries_input;
        if !file_entries_input_sorted {
            file_entries.sort_by(|left, right| left.relative_path.cmp(&right.relative_path));
        }

        build_local_sync_bundle_blocking(file_entries, empty_directory_relative_paths)
            .map(BuiltSyncBundle::TempPath)
    })
    .await
    .map_err(|error| format!("Sync bundle worker task failed: {error}"))?
}

pub(super) fn unpack_sync_bundle_blocking(
    root_dir: PathBuf,
    bundle_path: PathBuf,
    skip_existing_target_checks: bool,
) -> Result<SyncBundleExtractOutcome, String> {
    let bundle_file = fs::File::open(&bundle_path).map_err(|error| {
        format!(
            "Failed to open sync bundle archive {}: {error}",
            bundle_path.display()
        )
    })?;
    if should_use_rust_sync_bundle_extractor() {
        let mut bundle_file = bundle_file;
        if let Some(timings) = try_unpack_ustar_bundle_reader_blocking(
            &root_dir,
            &mut bundle_file,
            skip_existing_target_checks,
        )? {
            return Ok(SyncBundleExtractOutcome {
                extractor: "rust-ustar-stream",
                timings,
            });
        }
    }

    let bundle_file = fs::File::open(&bundle_path).map_err(|error| {
        format!(
            "Failed to reopen sync bundle archive {}: {error}",
            bundle_path.display()
        )
    })?;
    unpack_sync_bundle_reader_blocking(root_dir, bundle_file).map(|_| SyncBundleExtractOutcome {
        extractor: "tar",
        timings: SyncBundleExtractTimings::default(),
    })
}

pub(super) fn unpack_sync_bundle_bytes_blocking(
    root_dir: PathBuf,
    bundle_bytes: Vec<u8>,
    skip_existing_target_checks: bool,
) -> Result<SyncBundleExtractOutcome, String> {
    if should_use_rust_sync_bundle_extractor() {
        if let Some(timings) = try_unpack_ustar_bundle_bytes_blocking(
            &root_dir,
            &bundle_bytes,
            skip_existing_target_checks,
        )? {
            return Ok(SyncBundleExtractOutcome {
                extractor: "rust-ustar",
                timings,
            });
        }
    }

    unpack_sync_bundle_reader_blocking(root_dir, Cursor::new(bundle_bytes))?;
    Ok(SyncBundleExtractOutcome {
        extractor: "tar",
        timings: SyncBundleExtractTimings::default(),
    })
}

pub(super) fn resolve_in_memory_sync_bundle_extract_max_bytes() -> u64 {
    read_u64_env(IN_MEMORY_SYNC_BUNDLE_EXTRACT_MAX_BYTES_ENV)
        .unwrap_or(DEFAULT_IN_MEMORY_SYNC_BUNDLE_EXTRACT_MAX_BYTES)
}

fn build_local_sync_bundle_blocking(
    file_entries: Vec<FileEntry>,
    empty_directories: Vec<String>,
) -> Result<tempfile::TempPath, String> {
    let mut bundle_file = tempfile::NamedTempFile::new()
        .map_err(|error| format!("Failed to create temporary sync bundle file: {error}"))?;
    write_snapshot_tar_archive(bundle_file.as_file_mut(), &file_entries, &empty_directories)
        .map_err(|error| format!("Failed to build sync bundle archive: {error}"))?;
    bundle_file
        .as_file_mut()
        .flush()
        .map_err(|error| format!("Failed to flush sync bundle archive: {error}"))?;
    Ok(bundle_file.into_temp_path())
}

fn write_tar_file_list(relative_paths: &[String], list_file: &mut fs::File) -> Result<(), String> {
    for (index, relative_path) in relative_paths.iter().enumerate() {
        list_file
            .write_all(relative_path.as_bytes())
            .map_err(|error| {
                format!("Failed to write sync bundle file list entry {relative_path}: {error}")
            })?;
        if index + 1 < relative_paths.len() {
            list_file.write_all(&[0]).map_err(|error| {
                format!(
                    "Failed to write sync bundle file list separator after {relative_path}: {error}"
                )
            })?;
        }
    }
    list_file
        .flush()
        .map_err(|error| format!("Failed to flush sync bundle file list: {error}"))
}

pub(super) fn run_tar_with_file_list_to_path(
    root_dir: &Path,
    relative_paths: &[String],
    output_path: &Path,
) -> Result<bool, String> {
    if relative_paths.is_empty() {
        return Ok(false);
    }

    let mut list_file = tempfile::NamedTempFile::new()
        .map_err(|error| format!("Failed to create temporary sync bundle file list: {error}"))?;
    write_tar_file_list(relative_paths, list_file.as_file_mut())?;

    let status = match ProcessCommand::new("tar")
        .env("COPYFILE_DISABLE", "1")
        .env("COPY_EXTENDED_ATTRIBUTES_DISABLE", "1")
        .arg("-cf")
        .arg(output_path)
        .arg("--null")
        .arg("-T")
        .arg(list_file.path())
        .arg("-C")
        .arg(root_dir)
        .status()
    {
        Ok(status) => status,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(false),
        Err(_) => return Ok(false),
    };

    Ok(status.success())
}

fn try_build_local_sync_bundle_with_tar_blocking(
    root_dir: &Path,
    relative_paths: &[String],
) -> Result<Option<tempfile::TempPath>, String> {
    let mut bundle_file = tempfile::NamedTempFile::new()
        .map_err(|error| format!("Failed to create temporary sync bundle file: {error}"))?;
    if !run_tar_with_file_list_to_path(root_dir, relative_paths, bundle_file.path())? {
        return Ok(None);
    }

    bundle_file
        .as_file_mut()
        .flush()
        .map_err(|error| format!("Failed to flush sync bundle archive: {error}"))?;
    Ok(Some(bundle_file.into_temp_path()))
}

fn try_build_local_sync_bundle_root_with_tar_blocking(
    root_dir: &Path,
) -> Result<Option<tempfile::TempPath>, String> {
    let mut bundle_file = tempfile::NamedTempFile::new()
        .map_err(|error| format!("Failed to create temporary sync bundle file: {error}"))?;

    let status = match ProcessCommand::new("tar")
        .env("COPYFILE_DISABLE", "1")
        .env("COPY_EXTENDED_ATTRIBUTES_DISABLE", "1")
        .arg("-cf")
        .arg(bundle_file.path())
        .arg("--exclude")
        .arg(INTERNAL_SYNC_MANIFEST_RELATIVE_PATH)
        .arg("--exclude")
        .arg(INTERNAL_SYNC_BUNDLE_RELATIVE_PATH)
        .arg("-C")
        .arg(root_dir)
        .arg(".")
        .status()
    {
        Ok(status) => status,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(None),
        Err(_) => return Ok(None),
    };

    if !status.success() {
        return Ok(None);
    }

    bundle_file
        .as_file_mut()
        .flush()
        .map_err(|error| format!("Failed to flush sync bundle archive: {error}"))?;
    Ok(Some(bundle_file.into_temp_path()))
}

fn try_build_local_sync_bundle_with_tar_to_memory_blocking(
    root_dir: &Path,
    relative_paths: &[String],
) -> Result<Option<Vec<u8>>, String> {
    if relative_paths.is_empty() {
        return Ok(None);
    }

    let mut list_file = tempfile::NamedTempFile::new()
        .map_err(|error| format!("Failed to create temporary sync bundle file list: {error}"))?;
    write_tar_file_list(relative_paths, list_file.as_file_mut())?;

    let output = match ProcessCommand::new("tar")
        .env("COPYFILE_DISABLE", "1")
        .env("COPY_EXTENDED_ATTRIBUTES_DISABLE", "1")
        .arg("-cf")
        .arg("-")
        .arg("--null")
        .arg("-T")
        .arg(list_file.path())
        .arg("-C")
        .arg(root_dir)
        .output()
    {
        Ok(output) => output,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(None),
        Err(_) => return Ok(None),
    };

    if !output.status.success() {
        return Ok(None);
    }

    Ok(Some(output.stdout))
}

fn try_build_local_sync_bundle_root_with_tar_to_memory_blocking(
    root_dir: &Path,
) -> Result<Option<Vec<u8>>, String> {
    let output = match ProcessCommand::new("tar")
        .env("COPYFILE_DISABLE", "1")
        .env("COPY_EXTENDED_ATTRIBUTES_DISABLE", "1")
        .arg("-cf")
        .arg("-")
        .arg("--exclude")
        .arg(INTERNAL_SYNC_MANIFEST_RELATIVE_PATH)
        .arg("--exclude")
        .arg(INTERNAL_SYNC_BUNDLE_RELATIVE_PATH)
        .arg("-C")
        .arg(root_dir)
        .arg(".")
        .output()
    {
        Ok(output) => output,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(None),
        Err(_) => return Ok(None),
    };

    if !output.status.success() {
        return Ok(None);
    }

    Ok(Some(output.stdout))
}

fn read_u64_env(name: &str) -> Option<u64> {
    let raw = env::var(name).ok()?;
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return None;
    }

    trimmed.parse::<u64>().ok()
}

fn read_bool_env(name: &str) -> Option<bool> {
    let raw = env::var(name).ok()?;
    let normalized = raw.trim().to_ascii_lowercase();
    if normalized.is_empty() {
        return None;
    }

    if matches!(normalized.as_str(), "1" | "true" | "yes" | "on") {
        return Some(true);
    }

    if matches!(normalized.as_str(), "0" | "false" | "no" | "off") {
        return Some(false);
    }

    None
}

fn should_use_rust_sync_bundle_writer() -> bool {
    read_bool_env(RUST_SYNC_BUNDLE_WRITER_ENV).unwrap_or(true)
}

fn should_use_rust_sync_bundle_extractor() -> bool {
    read_bool_env(RUST_SYNC_BUNDLE_EXTRACTOR_ENV).unwrap_or(true)
}

fn resolve_in_memory_sync_bundle_source_byte_range() -> InMemorySyncBundleSourceByteRange {
    let min = read_u64_env(IN_MEMORY_SYNC_BUNDLE_MIN_SOURCE_BYTES_ENV)
        .unwrap_or(DEFAULT_IN_MEMORY_SYNC_BUNDLE_MIN_SOURCE_BYTES);
    let mut max = read_u64_env(IN_MEMORY_SYNC_BUNDLE_MAX_SOURCE_BYTES_ENV)
        .unwrap_or(DEFAULT_IN_MEMORY_SYNC_BUNDLE_MAX_SOURCE_BYTES);
    if max < min {
        max = min;
    }

    InMemorySyncBundleSourceByteRange { min, max }
}

fn should_build_sync_bundle_in_memory(snapshot_total_bytes: u64) -> bool {
    let range = resolve_in_memory_sync_bundle_source_byte_range();
    (range.min..=range.max).contains(&snapshot_total_bytes)
}

fn unpack_sync_bundle_reader_blocking<R: Read>(root_dir: PathBuf, reader: R) -> Result<(), String> {
    fs::create_dir_all(&root_dir).map_err(|error| {
        format!(
            "Failed to create local bundle root {}: {error}",
            root_dir.display()
        )
    })?;
    let mut archive = tar::Archive::new(reader);
    archive.unpack(&root_dir).map_err(|error| {
        format!(
            "Failed to unpack sync bundle into {}: {error}",
            root_dir.display()
        )
    })
}
