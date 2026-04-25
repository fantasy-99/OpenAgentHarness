use std::fs;
use std::io;
use std::path::Path;

pub(crate) async fn prune_empty_local_directories(root_dir: &Path) -> Result<(), String> {
    let root_dir = root_dir.to_path_buf();
    tokio::task::spawn_blocking(move || prune_empty_local_directories_blocking(&root_dir))
        .await
        .map_err(|error| format!("Empty directory prune worker task failed: {error}"))?
}

pub(crate) async fn is_local_directory_empty(target_path: &Path) -> Result<bool, String> {
    match tokio::fs::metadata(target_path).await {
        Ok(metadata) if !metadata.is_dir() => Ok(false),
        Ok(_) => {
            let mut entries = tokio::fs::read_dir(target_path).await.map_err(|error| {
                format!(
                    "Failed to read local directory {}: {error}",
                    target_path.display()
                )
            })?;
            Ok(entries
                .next_entry()
                .await
                .map_err(|error| {
                    format!(
                        "Failed to inspect local directory {}: {error}",
                        target_path.display()
                    )
                })?
                .is_none())
        }
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(true),
        Err(error) => Err(format!(
            "Failed to stat local directory {}: {error}",
            target_path.display()
        )),
    }
}

pub(crate) async fn stat_local_path(target_path: &Path) -> Result<Option<fs::Metadata>, String> {
    match tokio::fs::metadata(target_path).await {
        Ok(metadata) => Ok(Some(metadata)),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(format!(
            "Failed to stat local path {}: {error}",
            target_path.display()
        )),
    }
}

pub(crate) async fn remove_local_path(target_path: &Path) -> Result<bool, String> {
    let Some(metadata) = stat_local_path(target_path).await? else {
        return Ok(false);
    };

    if metadata.is_dir() {
        tokio::fs::remove_dir_all(target_path)
            .await
            .map_err(|error| {
                format!(
                    "Failed to remove local directory {}: {error}",
                    target_path.display()
                )
            })?;
    } else {
        tokio::fs::remove_file(target_path).await.map_err(|error| {
            format!(
                "Failed to remove local file {}: {error}",
                target_path.display()
            )
        })?;
    }

    Ok(true)
}

pub(crate) async fn ensure_local_directory(target_path: &Path) -> Result<bool, String> {
    match stat_local_path(target_path).await? {
        Some(metadata) if metadata.is_dir() => return Ok(false),
        Some(_) => {
            remove_local_path(target_path).await?;
        }
        None => {}
    }

    tokio::fs::create_dir_all(target_path)
        .await
        .map_err(|error| {
            format!(
                "Failed to create local directory {}: {error}",
                target_path.display()
            )
        })?;

    Ok(true)
}

pub(crate) async fn prepare_local_file_target(
    target_path: &Path,
) -> Result<Option<fs::Metadata>, String> {
    let existing = match stat_local_path(target_path).await? {
        Some(metadata) if metadata.is_file() => Some(metadata),
        Some(_) => {
            remove_local_path(target_path).await?;
            None
        }
        None => None,
    };

    if let Some(parent) = target_path.parent() {
        tokio::fs::create_dir_all(parent).await.map_err(|error| {
            format!(
                "Failed to create parent directory {}: {error}",
                parent.display()
            )
        })?;
    }

    Ok(existing)
}

fn prune_empty_local_directories_blocking(root_dir: &Path) -> Result<(), String> {
    let Ok(metadata) = fs::metadata(root_dir) else {
        return Ok(());
    };
    if !metadata.is_dir() {
        return Ok(());
    }

    fn walk(directory: &Path) -> Result<bool, String> {
        let entries = match fs::read_dir(directory) {
            Ok(entries) => entries,
            Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(false),
            Err(error) => {
                return Err(format!(
                    "Failed to read local directory {} while pruning empty directories: {error}",
                    directory.display()
                ));
            }
        };

        let mut has_children = false;
        for entry in entries {
            let entry = entry.map_err(|error| {
                format!(
                    "Failed to read local directory entry in {} while pruning empty directories: {error}",
                    directory.display()
                )
            })?;
            let path = entry.path();
            let file_type = entry.file_type().map_err(|error| {
                format!(
                    "Failed to inspect local directory entry {} while pruning empty directories: {error}",
                    path.display()
                )
            })?;

            if file_type.is_dir() {
                let keep_child = walk(&path)?;
                if !keep_child {
                    fs::remove_dir_all(&path).map_err(|error| {
                        format!(
                            "Failed to remove empty local directory {}: {error}",
                            path.display()
                        )
                    })?;
                    continue;
                }
            }

            has_children = true;
        }

        Ok(has_children)
    }

    walk(root_dir)?;
    Ok(())
}
