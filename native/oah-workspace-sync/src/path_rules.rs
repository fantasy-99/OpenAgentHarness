use std::collections::BTreeSet;
use std::path::Path;

pub(crate) const INTERNAL_SYNC_MANIFEST_RELATIVE_PATH: &str = ".oah-sync-manifest.json";
pub(crate) const INTERNAL_SYNC_BUNDLE_RELATIVE_PATH: &str = ".oah-sync-bundle.tar";

pub(crate) fn normalize_path(value: &Path) -> String {
    value.to_string_lossy().replace('\\', "/")
}

pub(crate) fn normalize_relative_path(value: &str) -> String {
    value.replace('\\', "/").trim_matches('/').to_string()
}

pub(crate) fn normalize_exclude_paths(paths: Vec<String>) -> Vec<String> {
    paths
        .into_iter()
        .map(|path| normalize_relative_path(&path))
        .filter(|path| !path.is_empty())
        .collect()
}

pub(crate) fn build_remote_path(base_path: &str, relative_path: &str) -> String {
    let normalized_base = base_path
        .replace('\\', "/")
        .trim_end_matches('/')
        .to_string();
    let normalized_relative = normalize_relative_path(relative_path);

    if normalized_base.is_empty() {
        return normalized_relative;
    }

    if normalized_relative.is_empty() {
        return normalized_base;
    }

    format!("{normalized_base}/{normalized_relative}")
}

pub(crate) fn should_ignore_relative_path(relative_path: &str) -> bool {
    if relative_path.is_empty() {
        return false;
    }

    let normalized_relative_path = normalize_relative_path(relative_path);
    if normalized_relative_path == INTERNAL_SYNC_MANIFEST_RELATIVE_PATH {
        return true;
    }

    if normalized_relative_path == INTERNAL_SYNC_BUNDLE_RELATIVE_PATH {
        return true;
    }

    let segments: Vec<&str> = relative_path.split('/').collect();
    if segments.iter().any(|segment| *segment == "__pycache__") {
        return true;
    }

    match segments.last().copied() {
        Some(".DS_Store") => true,
        Some(basename) if basename.ends_with(".pyc") => true,
        Some(basename) if basename.ends_with(".db-shm") => true,
        Some(basename) if basename.ends_with(".db-wal") => true,
        _ => false,
    }
}

pub(crate) fn should_exclude_relative_path(relative_path: &str, excludes: &[String]) -> bool {
    excludes.iter().any(|exclude| {
        relative_path == exclude || relative_path.starts_with(&format!("{exclude}/"))
    })
}

pub(crate) fn relative_path_from_remote_key(prefix: &str, key: &str) -> Option<String> {
    let normalized_prefix = normalize_relative_path(prefix);
    if normalized_prefix.is_empty() {
        return Some(normalize_relative_path(key));
    }

    if key == normalized_prefix {
        return Some(String::new());
    }

    key.strip_prefix(&format!("{normalized_prefix}/"))
        .map(normalize_relative_path)
}

pub(crate) fn add_directory_with_parents(relative_path: &str, directories: &mut BTreeSet<String>) {
    let normalized = normalize_relative_path(relative_path);
    if normalized.is_empty() {
        return;
    }

    let segments = normalized.split('/').collect::<Vec<_>>();
    for index in 0..segments.len() {
        let candidate = segments[..=index].join("/");
        if !candidate.is_empty() {
            directories.insert(candidate);
        }
    }
}

pub(crate) fn should_preserve_top_level_name(
    relative_path: &str,
    preserve_top_level_names: &[String],
) -> bool {
    const EMPTY: &str = "";

    let normalized = normalize_relative_path(relative_path);
    if normalized.is_empty() {
        return false;
    }

    let top_level_name = normalized.split('/').next().unwrap_or(EMPTY);
    !top_level_name.is_empty()
        && preserve_top_level_names
            .iter()
            .any(|candidate| candidate == top_level_name)
}
