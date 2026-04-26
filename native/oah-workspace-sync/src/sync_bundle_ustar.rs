use std::collections::HashSet;
use std::env;
use std::fs;
use std::io::{self, Read, Write};
use std::path::{Path, PathBuf};
use std::thread;
use std::time::Instant;

use filetime::{set_file_handle_times, FileTime};

use crate::path_rules::normalize_relative_path;
use crate::sync_bundle::SyncBundleExtractTimings;

const TAR_BLOCK_SIZE: usize = 512;
const PARALLEL_MEMORY_EXTRACT_MIN_FILES: usize = 64;
const PARALLEL_MEMORY_EXTRACT_MAX_THREADS: usize = 8;
const PARALLEL_MEMORY_EXTRACTOR_ENV: &str = "OAH_NATIVE_WORKSPACE_SYNC_PARALLEL_MEMORY_EXTRACTOR";
const PARALLEL_MEMORY_EXTRACTOR_THREADS_ENV: &str =
    "OAH_NATIVE_WORKSPACE_SYNC_PARALLEL_MEMORY_EXTRACTOR_THREADS";

enum ParsedUstarEntry<'a> {
    File {
        target_path: PathBuf,
        contents: &'a [u8],
        mode: u32,
        mtime_seconds: u64,
    },
    Directory {
        target_path: PathBuf,
        mode: u32,
    },
}

fn parse_tar_octal_field(field: &[u8]) -> Option<u64> {
    let text = field
        .iter()
        .copied()
        .take_while(|byte| *byte != 0)
        .filter(|byte| !byte.is_ascii_whitespace())
        .collect::<Vec<_>>();
    if text.is_empty() {
        return Some(0);
    }

    std::str::from_utf8(&text)
        .ok()
        .and_then(|value| u64::from_str_radix(value, 8).ok())
}

fn tar_header_name(header: &[u8; TAR_BLOCK_SIZE]) -> Option<String> {
    let name_end = header[0..100]
        .iter()
        .position(|byte| *byte == 0)
        .unwrap_or(100);
    let name = std::str::from_utf8(&header[0..name_end]).ok()?;
    let prefix_end = header[345..500]
        .iter()
        .position(|byte| *byte == 0)
        .unwrap_or(155);
    let prefix = std::str::from_utf8(&header[345..345 + prefix_end]).ok()?;
    if prefix.is_empty() {
        Some(name.to_string())
    } else {
        Some(format!("{prefix}/{name}"))
    }
}

fn safe_bundle_relative_path(raw_path: &str) -> Option<PathBuf> {
    let normalized = normalize_relative_path(raw_path.trim_start_matches("./"));
    if normalized.is_empty() || normalized == "." {
        return None;
    }

    let mut relative_path = PathBuf::new();
    for segment in normalized.split('/') {
        if segment.is_empty() || segment == "." || segment == ".." {
            return None;
        }
        relative_path.push(segment);
    }
    Some(relative_path)
}

fn skip_reader_bytes<R: Read>(reader: &mut R, mut remaining: u64) -> io::Result<()> {
    let mut buffer = [0_u8; 8192];
    while remaining > 0 {
        let chunk_len = usize::try_from(remaining.min(buffer.len() as u64)).unwrap_or(buffer.len());
        reader.read_exact(&mut buffer[..chunk_len])?;
        remaining -= chunk_len as u64;
    }
    Ok(())
}

fn copy_reader_bytes_to_file<R: Read>(
    reader: &mut R,
    file: &mut fs::File,
    mut remaining: u64,
) -> io::Result<()> {
    let mut buffer = [0_u8; 64 * 1024];
    while remaining > 0 {
        let chunk_len = usize::try_from(remaining.min(buffer.len() as u64)).unwrap_or(buffer.len());
        reader.read_exact(&mut buffer[..chunk_len])?;
        file.write_all(&buffer[..chunk_len])?;
        remaining -= chunk_len as u64;
    }
    Ok(())
}

fn ustar_padding_bytes(size: u64) -> u64 {
    let remainder = size % TAR_BLOCK_SIZE as u64;
    if remainder == 0 {
        0
    } else {
        TAR_BLOCK_SIZE as u64 - remainder
    }
}

pub(crate) fn try_unpack_ustar_bundle_reader_blocking<R: Read>(
    root_dir: &Path,
    reader: &mut R,
    skip_existing_target_checks: bool,
) -> Result<Option<SyncBundleExtractTimings>, String> {
    let mut timings = SyncBundleExtractTimings::default();
    let mkdir_started_at = Instant::now();
    fs::create_dir_all(root_dir).map_err(|error| {
        format!(
            "Failed to create local bundle root {}: {error}",
            root_dir.display()
        )
    })?;
    timings.mkdir_us += elapsed_micros_u64(mkdir_started_at);

    let mut saw_entry = false;
    let mut created_directories = HashSet::new();
    created_directories.insert(root_dir.to_path_buf());
    loop {
        let mut header = [0_u8; TAR_BLOCK_SIZE];
        match reader.read_exact(&mut header) {
            Ok(()) => {}
            Err(error) if error.kind() == io::ErrorKind::UnexpectedEof => return Ok(None),
            Err(error) => {
                return Err(format!(
                    "Failed to read ustar header while extracting sync bundle: {error}"
                ))
            }
        }

        if header.iter().all(|byte| *byte == 0) {
            return Ok(if saw_entry { Some(timings) } else { None });
        }

        if &header[257..263] != b"ustar\0" {
            return Ok(None);
        }

        let raw_path = tar_header_name(&header).ok_or_else(|| {
            "Failed to decode ustar header path while extracting sync bundle.".to_string()
        })?;
        let Some(relative_path) = safe_bundle_relative_path(&raw_path) else {
            return Ok(None);
        };
        let size = parse_tar_octal_field(&header[124..136]).ok_or_else(|| {
            format!("Failed to parse ustar entry size for {raw_path} while extracting sync bundle.")
        })?;
        let mode = parse_tar_octal_field(&header[100..108]).unwrap_or(0o644) as u32;
        let mtime_seconds = parse_tar_octal_field(&header[136..148]).unwrap_or(0);
        let target_path = root_dir.join(&relative_path);

        match header[156] {
            b'0' | 0 => {
                extract_streaming_file_entry(
                    reader,
                    &target_path,
                    size,
                    mode,
                    mtime_seconds,
                    skip_existing_target_checks,
                    &mut created_directories,
                    &mut timings,
                )?;
            }
            b'5' => {
                extract_directory_entry(
                    reader,
                    &target_path,
                    size,
                    mode,
                    &mut created_directories,
                    &mut timings,
                )?;
            }
            _ => return Ok(None),
        }

        skip_reader_bytes(reader, ustar_padding_bytes(size))
            .map_err(|error| format!("Failed to skip ustar padding after {raw_path}: {error}"))?;
        saw_entry = true;
    }
}

pub(crate) fn try_unpack_ustar_bundle_bytes_blocking(
    root_dir: &Path,
    bundle_bytes: &[u8],
    skip_existing_target_checks: bool,
) -> Result<Option<SyncBundleExtractTimings>, String> {
    if bundle_bytes.len() < TAR_BLOCK_SIZE * 2 || bundle_bytes.len() % TAR_BLOCK_SIZE != 0 {
        return Ok(None);
    }

    let mut offset = 0;
    let mut saw_entry = false;
    let mut entries = Vec::new();
    while offset + TAR_BLOCK_SIZE <= bundle_bytes.len() {
        let header_slice = &bundle_bytes[offset..offset + TAR_BLOCK_SIZE];
        if header_slice.iter().all(|byte| *byte == 0) {
            if !saw_entry {
                return Ok(None);
            }
            return extract_parsed_ustar_entries(root_dir, entries, skip_existing_target_checks)
                .map(Some);
        }

        let header: &[u8; TAR_BLOCK_SIZE] = header_slice
            .try_into()
            .map_err(|_| "Failed to read ustar header block.".to_string())?;
        if &header[257..263] != b"ustar\0" {
            return Ok(None);
        }

        let raw_path = tar_header_name(header).ok_or_else(|| {
            "Failed to decode ustar header path while extracting sync bundle.".to_string()
        })?;
        let Some(relative_path) = safe_bundle_relative_path(&raw_path) else {
            return Ok(None);
        };
        let size = parse_tar_octal_field(&header[124..136]).ok_or_else(|| {
            format!("Failed to parse ustar entry size for {raw_path} while extracting sync bundle.")
        })?;
        let mode = parse_tar_octal_field(&header[100..108]).unwrap_or(0o644) as u32;
        let mtime_seconds = parse_tar_octal_field(&header[136..148]).unwrap_or(0);
        let data_offset = offset + TAR_BLOCK_SIZE;
        let size_usize = usize::try_from(size).map_err(|_| {
            format!("Ustar entry {raw_path} is too large to extract on this platform.")
        })?;
        let data_end = data_offset.checked_add(size_usize).ok_or_else(|| {
            format!("Ustar entry {raw_path} overflowed while extracting sync bundle.")
        })?;
        if data_end > bundle_bytes.len() {
            return Ok(None);
        }

        let target_path = root_dir.join(&relative_path);
        match header[156] {
            b'0' | 0 => {
                entries.push(ParsedUstarEntry::File {
                    target_path,
                    contents: &bundle_bytes[data_offset..data_end],
                    mode,
                    mtime_seconds,
                });
            }
            b'5' => {
                entries.push(ParsedUstarEntry::Directory { target_path, mode });
            }
            _ => return Ok(None),
        }

        saw_entry = true;
        let padded_size = size_usize.div_ceil(TAR_BLOCK_SIZE) * TAR_BLOCK_SIZE;
        offset = data_offset
            .checked_add(padded_size)
            .ok_or_else(|| format!("Ustar entry {raw_path} overflowed archive bounds."))?;
    }

    Ok(None)
}

fn extract_parsed_ustar_entries(
    root_dir: &Path,
    entries: Vec<ParsedUstarEntry<'_>>,
    skip_existing_target_checks: bool,
) -> Result<SyncBundleExtractTimings, String> {
    if should_parallel_extract_memory_entries(&entries, skip_existing_target_checks) {
        return extract_parsed_ustar_entries_parallel(root_dir, &entries);
    }

    let mut timings = create_root_extract_timings(root_dir)?;
    let mut created_directories = HashSet::new();
    created_directories.insert(root_dir.to_path_buf());
    for entry in entries {
        match entry {
            ParsedUstarEntry::File {
                target_path,
                contents,
                mode,
                mtime_seconds,
            } => {
                extract_memory_file_entry(
                    contents,
                    &target_path,
                    mode,
                    mtime_seconds,
                    skip_existing_target_checks,
                    &mut created_directories,
                    &mut timings,
                )?;
            }
            ParsedUstarEntry::Directory { target_path, mode } => {
                if created_directories.insert(target_path.clone()) {
                    create_directory(&target_path, &mut timings)?;
                }
                set_directory_mode_if_needed(&target_path, mode, &mut timings)?;
                timings.directory_count += 1;
            }
        }
    }
    Ok(timings)
}

fn should_parallel_extract_memory_entries(
    entries: &[ParsedUstarEntry<'_>],
    skip_existing_target_checks: bool,
) -> bool {
    should_use_parallel_memory_extractor()
        && skip_existing_target_checks
        && entries
            .iter()
            .filter(|entry| matches!(entry, ParsedUstarEntry::File { .. }))
            .count()
            >= PARALLEL_MEMORY_EXTRACT_MIN_FILES
        && available_parallel_extract_threads() > 1
}

fn available_parallel_extract_threads() -> usize {
    let default_threads = thread::available_parallelism()
        .map(|value| value.get())
        .unwrap_or(1)
        .min(PARALLEL_MEMORY_EXTRACT_MAX_THREADS);
    read_usize_env(PARALLEL_MEMORY_EXTRACTOR_THREADS_ENV)
        .unwrap_or(default_threads)
        .min(PARALLEL_MEMORY_EXTRACT_MAX_THREADS)
        .max(1)
}

fn should_use_parallel_memory_extractor() -> bool {
    read_bool_env(PARALLEL_MEMORY_EXTRACTOR_ENV).unwrap_or(false)
}

fn read_usize_env(name: &str) -> Option<usize> {
    let raw = env::var(name).ok()?;
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return None;
    }

    trimmed.parse::<usize>().ok().filter(|value| *value > 0)
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

fn extract_parsed_ustar_entries_parallel(
    root_dir: &Path,
    entries: &[ParsedUstarEntry<'_>],
) -> Result<SyncBundleExtractTimings, String> {
    let mut timings = create_root_extract_timings(root_dir)?;
    let mut created_directories = HashSet::new();
    created_directories.insert(root_dir.to_path_buf());
    let mut file_entries = Vec::new();

    for entry in entries {
        match entry {
            ParsedUstarEntry::File { .. } => file_entries.push(entry),
            ParsedUstarEntry::Directory { target_path, mode } => {
                if created_directories.insert(target_path.clone()) {
                    create_directory(target_path, &mut timings)?;
                }
                set_directory_mode_if_needed(target_path, *mode, &mut timings)?;
                timings.directory_count += 1;
            }
        }
    }

    let worker_count = available_parallel_extract_threads().min(file_entries.len());
    let chunk_size = file_entries.len().div_ceil(worker_count);
    thread::scope(|scope| {
        let handles = file_entries
            .chunks(chunk_size)
            .map(|chunk| {
                scope.spawn(move || {
                    let mut worker_timings = SyncBundleExtractTimings::default();
                    let mut worker_created_directories = HashSet::new();
                    worker_created_directories.insert(root_dir.to_path_buf());
                    for entry in chunk {
                        if let ParsedUstarEntry::File {
                            target_path,
                            contents,
                            mode,
                            mtime_seconds,
                        } = entry
                        {
                            extract_memory_file_entry(
                                contents,
                                target_path,
                                *mode,
                                *mtime_seconds,
                                true,
                                &mut worker_created_directories,
                                &mut worker_timings,
                            )?;
                        }
                    }
                    Ok::<SyncBundleExtractTimings, String>(worker_timings)
                })
            })
            .collect::<Vec<_>>();

        for handle in handles {
            let worker_timings = handle
                .join()
                .map_err(|_| "Parallel ustar extraction worker panicked.".to_string())??;
            merge_extract_timings(&mut timings, worker_timings);
        }
        Ok(timings)
    })
}

fn create_root_extract_timings(root_dir: &Path) -> Result<SyncBundleExtractTimings, String> {
    let mut timings = SyncBundleExtractTimings::default();
    let mkdir_started_at = Instant::now();
    fs::create_dir_all(root_dir).map_err(|error| {
        format!(
            "Failed to create local bundle root {}: {error}",
            root_dir.display()
        )
    })?;
    timings.mkdir_us += elapsed_micros_u64(mkdir_started_at);
    Ok(timings)
}

fn merge_extract_timings(target: &mut SyncBundleExtractTimings, source: SyncBundleExtractTimings) {
    target.mkdir_us += source.mkdir_us;
    target.replace_us += source.replace_us;
    target.file_create_us += source.file_create_us;
    target.file_write_us += source.file_write_us;
    target.file_mtime_us += source.file_mtime_us;
    target.chmod_us += source.chmod_us;
    target.target_check_us += source.target_check_us;
    target.file_count += source.file_count;
    target.directory_count += source.directory_count;
}

fn extract_streaming_file_entry<R: Read>(
    reader: &mut R,
    target_path: &Path,
    size: u64,
    mode: u32,
    mtime_seconds: u64,
    skip_existing_target_checks: bool,
    created_directories: &mut HashSet<PathBuf>,
    timings: &mut SyncBundleExtractTimings,
) -> Result<(), String> {
    ensure_parent_directory(target_path, created_directories, timings)?;
    maybe_replace_existing_directory(target_path, skip_existing_target_checks, timings)?;

    let file_create_started_at = Instant::now();
    let mut file = fs::File::create(target_path).map_err(|error| {
        format!(
            "Failed to create local bundle file {}: {error}",
            target_path.display()
        )
    })?;
    timings.file_create_us += elapsed_micros_u64(file_create_started_at);

    let file_write_started_at = Instant::now();
    copy_reader_bytes_to_file(reader, &mut file, size).map_err(|error| {
        format!(
            "Failed to write local bundle file {}: {error}",
            target_path.display()
        )
    })?;
    timings.file_write_us += elapsed_micros_u64(file_write_started_at);

    finish_file_entry(&file, target_path, mode, mtime_seconds, timings)?;
    timings.file_count += 1;
    Ok(())
}

fn extract_memory_file_entry(
    contents: &[u8],
    target_path: &Path,
    mode: u32,
    mtime_seconds: u64,
    skip_existing_target_checks: bool,
    created_directories: &mut HashSet<PathBuf>,
    timings: &mut SyncBundleExtractTimings,
) -> Result<(), String> {
    ensure_parent_directory(target_path, created_directories, timings)?;
    maybe_replace_existing_directory(target_path, skip_existing_target_checks, timings)?;

    let file_create_started_at = Instant::now();
    let mut file = fs::File::create(target_path).map_err(|error| {
        format!(
            "Failed to create local bundle file {}: {error}",
            target_path.display()
        )
    })?;
    timings.file_create_us += elapsed_micros_u64(file_create_started_at);

    let file_write_started_at = Instant::now();
    file.write_all(contents).map_err(|error| {
        format!(
            "Failed to write local bundle file {}: {error}",
            target_path.display()
        )
    })?;
    timings.file_write_us += elapsed_micros_u64(file_write_started_at);

    finish_file_entry(&file, target_path, mode, mtime_seconds, timings)?;
    timings.file_count += 1;
    Ok(())
}

fn extract_directory_entry<R: Read>(
    reader: &mut R,
    target_path: &Path,
    size: u64,
    mode: u32,
    created_directories: &mut HashSet<PathBuf>,
    timings: &mut SyncBundleExtractTimings,
) -> Result<(), String> {
    if created_directories.insert(target_path.to_path_buf()) {
        create_directory(target_path, timings)?;
    }
    set_directory_mode_if_needed(target_path, mode, timings)?;
    skip_reader_bytes(reader, size).map_err(|error| {
        format!(
            "Failed to skip local bundle directory payload {}: {error}",
            target_path.display()
        )
    })?;
    timings.directory_count += 1;
    Ok(())
}

fn ensure_parent_directory(
    target_path: &Path,
    created_directories: &mut HashSet<PathBuf>,
    timings: &mut SyncBundleExtractTimings,
) -> Result<(), String> {
    if let Some(parent) = target_path.parent() {
        let parent_path = parent.to_path_buf();
        if created_directories.insert(parent_path.clone()) {
            create_directory(&parent_path, timings)?;
        }
    }
    Ok(())
}

fn create_directory(
    target_path: &Path,
    timings: &mut SyncBundleExtractTimings,
) -> Result<(), String> {
    let mkdir_started_at = Instant::now();
    fs::create_dir_all(target_path).map_err(|error| {
        format!(
            "Failed to create local bundle directory {}: {error}",
            target_path.display()
        )
    })?;
    timings.mkdir_us += elapsed_micros_u64(mkdir_started_at);
    Ok(())
}

fn maybe_replace_existing_directory(
    target_path: &Path,
    skip_existing_target_checks: bool,
    timings: &mut SyncBundleExtractTimings,
) -> Result<(), String> {
    if skip_existing_target_checks {
        return Ok(());
    }

    let target_check_started_at = Instant::now();
    let existing_directory = matches!(fs::metadata(target_path), Ok(metadata) if metadata.is_dir());
    timings.target_check_us += elapsed_micros_u64(target_check_started_at);
    if existing_directory {
        let replace_started_at = Instant::now();
        fs::remove_dir_all(target_path).map_err(|error| {
            format!(
                "Failed to replace local bundle directory {}: {error}",
                target_path.display()
            )
        })?;
        timings.replace_us += elapsed_micros_u64(replace_started_at);
    }
    Ok(())
}

fn finish_file_entry(
    file: &fs::File,
    target_path: &Path,
    mode: u32,
    mtime_seconds: u64,
    timings: &mut SyncBundleExtractTimings,
) -> Result<(), String> {
    set_file_mode_if_needed(target_path, mode, timings)?;
    if mtime_seconds > 0 {
        let file_mtime_started_at = Instant::now();
        set_file_handle_times(
            file,
            None,
            Some(FileTime::from_unix_time(
                mtime_seconds.min(i64::MAX as u64) as i64,
                0,
            )),
        )
        .map_err(|error| {
            format!(
                "Failed to set mtime on local bundle file {}: {error}",
                target_path.display()
            )
        })?;
        timings.file_mtime_us += elapsed_micros_u64(file_mtime_started_at);
    }
    Ok(())
}

fn set_file_mode_if_needed(
    target_path: &Path,
    mode: u32,
    timings: &mut SyncBundleExtractTimings,
) -> Result<(), String> {
    #[cfg(unix)]
    {
        if mode & 0o7777 != 0o644 {
            use std::os::unix::fs::PermissionsExt;
            let permissions = fs::Permissions::from_mode(mode & 0o7777);
            let chmod_started_at = Instant::now();
            fs::set_permissions(target_path, permissions).map_err(|error| {
                format!(
                    "Failed to set permissions on local bundle file {}: {error}",
                    target_path.display()
                )
            })?;
            timings.chmod_us += elapsed_micros_u64(chmod_started_at);
        }
    }
    Ok(())
}

fn set_directory_mode_if_needed(
    target_path: &Path,
    mode: u32,
    timings: &mut SyncBundleExtractTimings,
) -> Result<(), String> {
    #[cfg(unix)]
    {
        if mode & 0o7777 != 0o755 {
            use std::os::unix::fs::PermissionsExt;
            let permissions = fs::Permissions::from_mode(mode & 0o7777);
            let chmod_started_at = Instant::now();
            fs::set_permissions(target_path, permissions).map_err(|error| {
                format!(
                    "Failed to set permissions on local bundle directory {}: {error}",
                    target_path.display()
                )
            })?;
            timings.chmod_us += elapsed_micros_u64(chmod_started_at);
        }
    }
    Ok(())
}

fn elapsed_micros_u64(started_at: Instant) -> u64 {
    u64::try_from(started_at.elapsed().as_micros()).unwrap_or(u64::MAX)
}
