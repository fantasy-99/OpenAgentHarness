use std::collections::{BTreeMap, BTreeSet, HashMap};

use reqwest::header::{HeaderMap, HeaderName, HeaderValue, CONTENT_TYPE};
use reqwest::{Client as HttpClient, StatusCode, Url};
use serde::Deserialize;
use time::{format_description::well_known::Rfc3339, OffsetDateTime};

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct NativeSandboxHttpConfig {
    pub(crate) base_url: String,
    pub(crate) sandbox_id: String,
    #[serde(default)]
    pub(crate) headers: HashMap<String, String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct NativeSandboxHttpFileStat {
    pub(crate) kind: String,
    pub(crate) size: u64,
    pub(crate) mtime_ms: f64,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct NativeSandboxHttpEntryPage {
    items: Vec<NativeSandboxHttpEntry>,
    next_cursor: Option<String>,
}

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct NativeSandboxHttpEntry {
    pub(crate) path: String,
    #[serde(rename = "type")]
    pub(crate) entry_type: String,
    pub(crate) size_bytes: Option<u64>,
    pub(crate) updated_at: Option<String>,
}

pub(crate) struct NativeSandboxHttpRemoteState {
    pub(crate) existing_directories: BTreeSet<String>,
    pub(crate) existing_file_stats: BTreeMap<String, NativeSandboxHttpFileStat>,
}

#[derive(Clone)]
pub(crate) struct NativeSandboxHttpClient {
    client: HttpClient,
    base_url: String,
    route_prefix: String,
    sandbox_id: String,
}

pub(crate) fn parse_sandbox_http_base_url(input: &str) -> (String, String) {
    let trimmed = input.trim();
    if let Ok(mut url) = Url::parse(trimmed) {
        let path = url.path().trim_end_matches('/').to_string();
        let route_prefix = if path.ends_with("/internal/v1") {
            "/internal/v1"
        } else if path.ends_with("/api/v1") {
            "/api/v1"
        } else {
            ""
        };
        let normalized_path = if route_prefix.is_empty() {
            path
        } else {
            path.trim_end_matches(route_prefix)
                .trim_end_matches('/')
                .to_string()
        };
        url.set_path(if normalized_path.is_empty() {
            "/"
        } else {
            &normalized_path
        });
        url.set_query(None);
        url.set_fragment(None);
        return (
            url.to_string().trim_end_matches('/').to_string(),
            route_prefix.to_string(),
        );
    }

    let trimmed = trimmed.trim_end_matches('/').to_string();
    if let Some(base_url) = trimmed.strip_suffix("/internal/v1") {
        return (
            base_url.trim_end_matches('/').to_string(),
            "/internal/v1".to_string(),
        );
    }
    if let Some(base_url) = trimmed.strip_suffix("/api/v1") {
        return (
            base_url.trim_end_matches('/').to_string(),
            "/api/v1".to_string(),
        );
    }
    (trimmed, String::new())
}

impl NativeSandboxHttpClient {
    pub(crate) fn new(config: &NativeSandboxHttpConfig) -> Result<Self, String> {
        let mut headers = HeaderMap::new();
        for (key, value) in &config.headers {
            let name = HeaderName::from_bytes(key.as_bytes())
                .map_err(|error| format!("Invalid sandbox HTTP header name {key:?}: {error}"))?;
            let header_value = HeaderValue::from_str(value).map_err(|error| {
                format!("Invalid sandbox HTTP header value for {key:?}: {error}")
            })?;
            headers.insert(name, header_value);
        }

        let client = HttpClient::builder()
            .default_headers(headers)
            .build()
            .map_err(|error| format!("Failed to initialize sandbox HTTP client: {error}"))?;
        let (base_url, route_prefix) = parse_sandbox_http_base_url(&config.base_url);

        Ok(Self {
            client,
            base_url,
            route_prefix,
            sandbox_id: config.sandbox_id.clone(),
        })
    }

    fn build_url(&self, request_path: &str, query: &[(&str, String)]) -> Result<Url, String> {
        let mapped_path = if self.route_prefix.is_empty() {
            request_path.to_string()
        } else {
            request_path.replacen("/api/v1", &self.route_prefix, 1)
        };
        let mut url = Url::parse(&format!("{}{}", self.base_url, mapped_path))
            .map_err(|error| format!("Failed to build sandbox HTTP URL: {error}"))?;
        for (key, value) in query {
            url.query_pairs_mut().append_pair(key, value);
        }
        Ok(url)
    }

    pub(crate) async fn create_directory(&self, path: &str) -> Result<(), String> {
        let url = self.build_url(
            &format!("/api/v1/sandboxes/{}/directories", self.sandbox_id),
            &[],
        )?;
        let response = self
            .client
            .post(url)
            .json(&serde_json::json!({
                "path": path,
                "createParents": true
            }))
            .send()
            .await
            .map_err(|error| format!("Failed to create sandbox directory {path}: {error}"))?;
        if response.status().is_success() {
            return Ok(());
        }

        let status = response.status();
        let body = response
            .text()
            .await
            .unwrap_or_else(|_| String::from("<unavailable>"));
        Err(format!(
            "Failed to create sandbox directory {path}: HTTP {status} {body}"
        ))
    }

    pub(crate) async fn upload_file(
        &self,
        path: &str,
        data: Vec<u8>,
        mtime_ms: u128,
    ) -> Result<(), String> {
        let url = self.build_url(
            &format!("/api/v1/sandboxes/{}/files/upload", self.sandbox_id),
            &[
                ("path", path.to_string()),
                ("overwrite", "true".to_string()),
                ("mtimeMs", mtime_ms.to_string()),
            ],
        )?;
        let response = self
            .client
            .put(url)
            .header(CONTENT_TYPE, "application/octet-stream")
            .body(data)
            .send()
            .await
            .map_err(|error| format!("Failed to upload sandbox file {path}: {error}"))?;
        if response.status().is_success() {
            return Ok(());
        }

        let status = response.status();
        let body = response
            .text()
            .await
            .unwrap_or_else(|_| String::from("<unavailable>"));
        Err(format!(
            "Failed to upload sandbox file {path}: HTTP {status} {body}"
        ))
    }

    pub(crate) async fn stat_path(
        &self,
        path: &str,
    ) -> Result<Option<NativeSandboxHttpFileStat>, String> {
        let url = self.build_url(
            &format!("/api/v1/sandboxes/{}/files/stat", self.sandbox_id),
            &[("path", path.to_string())],
        )?;
        let response = self
            .client
            .get(url)
            .send()
            .await
            .map_err(|error| format!("Failed to stat sandbox file {path}: {error}"))?;
        if response.status() == StatusCode::NOT_FOUND {
            return Ok(None);
        }
        if response.status().is_success() {
            let payload = response
                .json::<NativeSandboxHttpFileStat>()
                .await
                .map_err(|error| {
                    format!("Failed to decode sandbox file stat response for {path}: {error}")
                })?;
            return Ok(Some(payload));
        }

        let status = response.status();
        let body = response
            .text()
            .await
            .unwrap_or_else(|_| String::from("<unavailable>"));
        Err(format!(
            "Failed to stat sandbox file {path}: HTTP {status} {body}"
        ))
    }

    async fn list_entries(
        &self,
        path: &str,
        cursor: Option<&str>,
    ) -> Result<NativeSandboxHttpEntryPage, String> {
        let mut query = vec![
            ("path", path.to_string()),
            ("pageSize", "200".to_string()),
            ("sortBy", "name".to_string()),
            ("sortOrder", "asc".to_string()),
        ];
        if let Some(cursor) = cursor {
            query.push(("cursor", cursor.to_string()));
        }
        let url = self.build_url(
            &format!("/api/v1/sandboxes/{}/files/entries", self.sandbox_id),
            &query,
        )?;
        let response = self
            .client
            .get(url)
            .send()
            .await
            .map_err(|error| format!("Failed to list sandbox entries under {path}: {error}"))?;
        if response.status() == StatusCode::NOT_FOUND {
            return Ok(NativeSandboxHttpEntryPage {
                items: Vec::new(),
                next_cursor: None,
            });
        }
        if response.status().is_success() {
            return response
                .json::<NativeSandboxHttpEntryPage>()
                .await
                .map_err(|error| {
                    format!("Failed to decode sandbox entry listing for {path}: {error}")
                });
        }

        let status = response.status();
        let body = response
            .text()
            .await
            .unwrap_or_else(|_| String::from("<unavailable>"));
        Err(format!(
            "Failed to list sandbox entries under {path}: HTTP {status} {body}"
        ))
    }

    pub(crate) async fn delete_entry(&self, path: &str, recursive: bool) -> Result<(), String> {
        let url = self.build_url(
            &format!("/api/v1/sandboxes/{}/files/entry", self.sandbox_id),
            &[
                ("path", path.to_string()),
                ("recursive", recursive.to_string()),
            ],
        )?;
        let response = self
            .client
            .delete(url)
            .send()
            .await
            .map_err(|error| format!("Failed to delete sandbox entry {path}: {error}"))?;
        if response.status() == StatusCode::NOT_FOUND {
            return Ok(());
        }
        if response.status().is_success() {
            return Ok(());
        }

        let status = response.status();
        let body = response
            .text()
            .await
            .unwrap_or_else(|_| String::from("<unavailable>"));
        Err(format!(
            "Failed to delete sandbox entry {path}: HTTP {status} {body}"
        ))
    }
}

pub(crate) fn sandbox_mtime_matches(local_mtime_ms: u128, remote_mtime_ms: f64) -> bool {
    (remote_mtime_ms - local_mtime_ms as f64).abs() < 1.0
}

pub(crate) fn sandbox_file_matches(
    local_size: u64,
    local_mtime_ms: u128,
    remote: &NativeSandboxHttpFileStat,
) -> bool {
    remote.kind == "file"
        && remote.size == local_size
        && sandbox_mtime_matches(local_mtime_ms, remote.mtime_ms)
}

fn parse_workspace_entry_updated_at_ms(value: &str) -> Option<f64> {
    let parsed = OffsetDateTime::parse(value.trim(), &Rfc3339).ok()?;
    Some(parsed.unix_timestamp_nanos() as f64 / 1_000_000.0)
}

pub(crate) fn sandbox_entry_file_stat(
    entry: &NativeSandboxHttpEntry,
) -> Option<NativeSandboxHttpFileStat> {
    if entry.entry_type != "file" {
        return None;
    }

    Some(NativeSandboxHttpFileStat {
        kind: "file".to_string(),
        size: entry.size_bytes?,
        mtime_ms: parse_workspace_entry_updated_at_ms(entry.updated_at.as_deref()?)?,
    })
}

pub(crate) async fn collect_remote_sandbox_entries(
    sandbox_client: &NativeSandboxHttpClient,
    root_path: &str,
) -> Result<Vec<NativeSandboxHttpEntry>, String> {
    let mut directories_to_visit = vec![root_path.to_string()];
    let mut collected = Vec::new();

    while let Some(current_path) = directories_to_visit.pop() {
        let mut cursor: Option<String> = None;
        loop {
            let page = sandbox_client
                .list_entries(&current_path, cursor.as_deref())
                .await?;
            for entry in page.items {
                if entry.entry_type == "directory" {
                    directories_to_visit.push(entry.path.clone());
                }
                collected.push(entry);
            }

            match page.next_cursor {
                Some(next_cursor) => {
                    cursor = Some(next_cursor);
                }
                None => break,
            }
        }
    }

    Ok(collected)
}

pub(crate) async fn prune_unexpected_remote_sandbox_entries(
    sandbox_client: &NativeSandboxHttpClient,
    root_path: &str,
    expected_directories: &BTreeSet<String>,
    expected_files: &BTreeSet<String>,
) -> Result<NativeSandboxHttpRemoteState, String> {
    let mut keep_directories = expected_directories.clone();
    keep_directories.insert(root_path.to_string());
    let mut remote_entries = collect_remote_sandbox_entries(sandbox_client, root_path).await?;
    remote_entries.sort_by(|left, right| right.path.len().cmp(&left.path.len()));
    let mut remote_state = NativeSandboxHttpRemoteState {
        existing_directories: BTreeSet::new(),
        existing_file_stats: BTreeMap::new(),
    };

    for entry in remote_entries {
        if should_keep_remote_sandbox_entry(&entry, &keep_directories, expected_files) {
            if entry.entry_type == "directory" {
                remote_state.existing_directories.insert(entry.path.clone());
            } else if let Some(file_stat) = sandbox_entry_file_stat(&entry) {
                remote_state
                    .existing_file_stats
                    .insert(entry.path.clone(), file_stat);
            }
            continue;
        }

        sandbox_client
            .delete_entry(&entry.path, entry.entry_type == "directory")
            .await?;
    }

    Ok(remote_state)
}

pub(crate) fn should_keep_remote_sandbox_entry(
    entry: &NativeSandboxHttpEntry,
    expected_directories: &BTreeSet<String>,
    expected_files: &BTreeSet<String>,
) -> bool {
    let keep_directory = entry.entry_type == "directory"
        && expected_directories.contains(&entry.path)
        && !expected_files.contains(&entry.path);
    let keep_file = entry.entry_type == "file"
        && expected_files.contains(&entry.path)
        && !expected_directories.contains(&entry.path);
    keep_directory || keep_file
}
