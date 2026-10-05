use std::path::{Path, PathBuf};

use anyhow::{bail, Context, Result};
use base64::Engine as _;
use chrono::{DateTime, Utc};
use reqwest::Client;
use serde_json::{json, Value};
use sqlx::SqlitePool;
use tokio::{
    fs,
    io::{AsyncReadExt, AsyncWriteExt},
};
use uuid::Uuid;

use crate::{
    model::{Artifact, ArtifactLogicalType},
    serde_db::{enum_from_string, enum_to_string, from_json, to_json},
};

#[derive(Clone)]
pub struct ArtifactStore {
    root: PathBuf,
    http: Client,
    pool: SqlitePool,
}

impl ArtifactStore {
    pub async fn new(root: impl Into<PathBuf>, pool: SqlitePool) -> Result<Self> {
        let root = root.into();
        fs::create_dir_all(&root)
            .await
            .with_context(|| format!("failed to create artifact root {}", root.display()))?;
        fs::create_dir_all(root.join(".tmp")).await?;
        Ok(Self {
            root,
            http: Client::new(),
            pool,
        })
    }

    pub fn root(&self) -> &Path {
        &self.root
    }

    pub async fn import_bytes(
        &self,
        bytes: &[u8],
        mime: impl Into<String>,
        source_url: Option<String>,
    ) -> Result<Artifact> {
        self.import_bytes_with_metadata(
            bytes,
            mime,
            source_url,
            ArtifactLogicalType::Other,
            json!({"kind": "UNSPECIFIED"}),
        )
        .await
    }

    pub async fn import_bytes_with_metadata(
        &self,
        bytes: &[u8],
        mime: impl Into<String>,
        source_url: Option<String>,
        logical_type: ArtifactLogicalType,
        source: Value,
    ) -> Result<Artifact> {
        let hash = blake3::hash(bytes).to_hex().to_string();
        if let Some(existing) = self
            .find_existing_with_metadata(&hash, logical_type, &source)
            .await?
        {
            self.restore_existing_from_bytes(&existing, bytes).await?;
            return Ok(existing);
        }

        let relative_path = relative_path_for_hash(&hash);
        let destination = self.root.join(&relative_path);
        if let Some(parent) = destination.parent() {
            fs::create_dir_all(parent).await?;
        }
        if !fs::try_exists(&destination).await.unwrap_or(false) {
            fs::write(&destination, bytes).await?;
        }

        self.insert_record(ArtifactInsert {
            content_hash: hash,
            mime: mime.into(),
            size_bytes: bytes.len() as u64,
            relative_path,
            logical_type,
            source,
            source_url,
        })
        .await
    }

    pub async fn import_file(
        &self,
        path: impl AsRef<Path>,
        mime: impl Into<String>,
        source_url: Option<String>,
    ) -> Result<Artifact> {
        self.import_file_with_metadata(
            path,
            mime,
            source_url,
            ArtifactLogicalType::Other,
            json!({"kind": "UNSPECIFIED"}),
        )
        .await
    }

    pub async fn import_file_with_metadata(
        &self,
        path: impl AsRef<Path>,
        mime: impl Into<String>,
        source_url: Option<String>,
        logical_type: ArtifactLogicalType,
        source: Value,
    ) -> Result<Artifact> {
        let path = path.as_ref();
        let mut input = fs::File::open(path)
            .await
            .with_context(|| format!("failed to open artifact source {}", path.display()))?;
        let temp_path = self.root.join(".tmp").join(Uuid::new_v4().to_string());
        let mut output = fs::File::create(&temp_path).await?;
        let mut hasher = blake3::Hasher::new();
        let mut size = 0_u64;
        let mut buffer = vec![0_u8; 64 * 1024];

        loop {
            let read = input.read(&mut buffer).await?;
            if read == 0 {
                break;
            }
            hasher.update(&buffer[..read]);
            output.write_all(&buffer[..read]).await?;
            size = size.saturating_add(read as u64);
        }
        output.flush().await?;
        drop(output);

        let hash = hasher.finalize().to_hex().to_string();
        if let Some(existing) = self
            .find_existing_with_metadata(&hash, logical_type, &source)
            .await?
        {
            self.restore_existing_from_temp(&existing, &temp_path)
                .await?;
            return Ok(existing);
        }

        let relative_path = relative_path_for_hash(&hash);
        let destination = self.root.join(&relative_path);
        if let Some(parent) = destination.parent() {
            fs::create_dir_all(parent).await?;
        }
        match fs::rename(&temp_path, &destination).await {
            Ok(()) => {}
            Err(error) if fs::try_exists(&destination).await.unwrap_or(false) => {
                let _ = fs::remove_file(&temp_path).await;
                tracing::debug!(
                    error = %error,
                    "artifact already existed during concurrent local import"
                );
            }
            Err(error) => return Err(error.into()),
        }

        self.insert_record(ArtifactInsert {
            content_hash: hash,
            mime: mime.into(),
            size_bytes: size,
            relative_path,
            logical_type,
            source,
            source_url,
        })
        .await
    }

    pub async fn import_source(
        &self,
        source: &str,
        content_type_hint: Option<&str>,
    ) -> Result<Artifact> {
        self.import_source_with_metadata(
            source,
            content_type_hint,
            ArtifactLogicalType::Other,
            json!({"kind": "REMOTE_OR_DATA_URI"}),
        )
        .await
    }

    pub async fn import_source_with_metadata(
        &self,
        source: &str,
        content_type_hint: Option<&str>,
        logical_type: ArtifactLogicalType,
        provenance: Value,
    ) -> Result<Artifact> {
        if is_data_uri(source) {
            let (mime, bytes) = decode_data_uri(source)?;
            return self
                .import_bytes_with_metadata(&bytes, mime, None, logical_type, provenance)
                .await;
        }
        if !source.starts_with("https://") {
            bail!("remote artifact source must use HTTPS or data URI");
        }
        self.download_http(source, content_type_hint, logical_type, provenance)
            .await
    }

    pub async fn get(&self, id: Uuid) -> Result<Option<Artifact>> {
        let row = sqlx::query_as::<_, ArtifactRow>(
            r#"
            SELECT id, content_hash, mime, size_bytes, relative_path,
                   logical_type, source_json, source_url, created_at
            FROM artifacts
            WHERE id = ?
            "#,
        )
        .bind(id.to_string())
        .fetch_optional(&self.pool)
        .await?;
        row.map(TryInto::try_into).transpose()
    }

    pub async fn absolute_path(&self, artifact: &Artifact) -> Result<PathBuf> {
        let path = self.root.join(&artifact.relative_path);
        let canonical_root = fs::canonicalize(&self.root).await?;
        let canonical = fs::canonicalize(&path)
            .await
            .with_context(|| format!("artifact file missing: {}", path.display()))?;
        if !canonical.starts_with(&canonical_root) {
            bail!("artifact escaped store root");
        }
        Ok(canonical)
    }

    pub async fn to_data_uri(&self, artifact: &Artifact) -> Result<String> {
        let path = self.absolute_path(artifact).await?;
        let bytes = fs::read(path).await?;
        let encoded = base64::engine::general_purpose::STANDARD.encode(bytes);
        Ok(format!("data:{};base64,{}", artifact.mime, encoded))
    }

    async fn download_http(
        &self,
        url: &str,
        content_type_hint: Option<&str>,
        logical_type: ArtifactLogicalType,
        source: Value,
    ) -> Result<Artifact> {
        let response = self
            .http
            .get(url)
            .send()
            .await
            .with_context(|| format!("failed to download artifact from {url}"))?
            .error_for_status()
            .with_context(|| format!("artifact download failed for {url}"))?;

        let mime = response
            .headers()
            .get(reqwest::header::CONTENT_TYPE)
            .and_then(|value| value.to_str().ok())
            .and_then(|value| value.split(';').next())
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .or(content_type_hint)
            .unwrap_or("application/octet-stream")
            .to_owned();

        let temp_path = self.root.join(".tmp").join(Uuid::new_v4().to_string());
        let mut file = fs::File::create(&temp_path).await?;
        let mut response = response;
        let mut hasher = blake3::Hasher::new();
        let mut size = 0_u64;

        while let Some(chunk) = response.chunk().await? {
            hasher.update(&chunk);
            size = size.saturating_add(chunk.len() as u64);
            file.write_all(&chunk).await?;
        }
        file.flush().await?;
        drop(file);

        let hash = hasher.finalize().to_hex().to_string();
        if let Some(existing) = self
            .find_existing_with_metadata(&hash, logical_type, &source)
            .await?
        {
            self.restore_existing_from_temp(&existing, &temp_path)
                .await?;
            return Ok(existing);
        }

        let relative_path = relative_path_for_hash(&hash);
        let destination = self.root.join(&relative_path);
        if let Some(parent) = destination.parent() {
            fs::create_dir_all(parent).await?;
        }
        match fs::rename(&temp_path, &destination).await {
            Ok(()) => {}
            Err(error) if fs::try_exists(&destination).await.unwrap_or(false) => {
                let _ = fs::remove_file(&temp_path).await;
                tracing::debug!(
                    error = %error,
                    "artifact already existed during concurrent import"
                );
            }
            Err(error) => return Err(error.into()),
        }

        self.insert_record(ArtifactInsert {
            content_hash: hash,
            mime,
            size_bytes: size,
            relative_path,
            logical_type,
            source,
            source_url: Some(redact_source_url(url)),
        })
        .await
    }

    async fn restore_existing_from_bytes(&self, artifact: &Artifact, bytes: &[u8]) -> Result<()> {
        let destination = self.root.join(&artifact.relative_path);
        if fs::try_exists(&destination).await.unwrap_or(false) {
            return Ok(());
        }
        if let Some(parent) = destination.parent() {
            fs::create_dir_all(parent).await?;
        }
        fs::write(&destination, bytes).await?;
        Ok(())
    }

    async fn restore_existing_from_temp(
        &self,
        artifact: &Artifact,
        temp_path: &Path,
    ) -> Result<()> {
        let destination = self.root.join(&artifact.relative_path);
        if fs::try_exists(&destination).await.unwrap_or(false) {
            let _ = fs::remove_file(temp_path).await;
            return Ok(());
        }
        if let Some(parent) = destination.parent() {
            fs::create_dir_all(parent).await?;
        }
        match fs::rename(temp_path, &destination).await {
            Ok(()) => Ok(()),
            Err(error) if fs::try_exists(&destination).await.unwrap_or(false) => {
                let _ = fs::remove_file(temp_path).await;
                tracing::debug!(
                    error = %error,
                    "artifact was restored by another concurrent import"
                );
                Ok(())
            }
            Err(error) => Err(error.into()),
        }
    }

    async fn find_existing_with_metadata(
        &self,
        hash: &str,
        logical_type: ArtifactLogicalType,
        source: &Value,
    ) -> Result<Option<Artifact>> {
        let Some(existing) = self.find_by_hash(hash).await? else {
            return Ok(None);
        };
        if existing.logical_type == ArtifactLogicalType::Other
            && logical_type != ArtifactLogicalType::Other
        {
            sqlx::query(
                r#"
                UPDATE artifacts
                SET logical_type = ?, source_json = ?
                WHERE id = ? AND logical_type = ?
                "#,
            )
            .bind(enum_to_string(&logical_type)?)
            .bind(to_json(source)?)
            .bind(existing.id.to_string())
            .bind(enum_to_string(&ArtifactLogicalType::Other)?)
            .execute(&self.pool)
            .await?;
            return self.get(existing.id).await;
        }
        Ok(Some(existing))
    }

    async fn find_by_hash(&self, hash: &str) -> Result<Option<Artifact>> {
        let row = sqlx::query_as::<_, ArtifactRow>(
            r#"
            SELECT id, content_hash, mime, size_bytes, relative_path,
                   logical_type, source_json, source_url, created_at
            FROM artifacts
            WHERE content_hash = ?
            "#,
        )
        .bind(hash)
        .fetch_optional(&self.pool)
        .await?;
        row.map(TryInto::try_into).transpose()
    }

    async fn insert_record(&self, input: ArtifactInsert) -> Result<Artifact> {
        let record = Artifact {
            id: Uuid::new_v4(),
            content_hash: input.content_hash,
            mime: input.mime,
            size_bytes: input.size_bytes,
            relative_path: input.relative_path,
            logical_type: input.logical_type,
            source: input.source,
            source_url: input.source_url,
            created_at: Utc::now(),
        };

        sqlx::query(
            r#"
            INSERT INTO artifacts(
                id, content_hash, mime, size_bytes, relative_path,
                logical_type, source_json, source_url, created_at
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(content_hash) DO NOTHING
            "#,
        )
        .bind(record.id.to_string())
        .bind(&record.content_hash)
        .bind(&record.mime)
        .bind(record.size_bytes as i64)
        .bind(&record.relative_path)
        .bind(enum_to_string(&record.logical_type)?)
        .bind(to_json(&record.source)?)
        .bind(&record.source_url)
        .bind(record.created_at.to_rfc3339())
        .execute(&self.pool)
        .await?;

        self.find_by_hash(&record.content_hash)
            .await?
            .context("artifact row missing after insert")
    }
}

struct ArtifactInsert {
    content_hash: String,
    mime: String,
    size_bytes: u64,
    relative_path: String,
    logical_type: ArtifactLogicalType,
    source: Value,
    source_url: Option<String>,
}

#[derive(sqlx::FromRow)]
struct ArtifactRow {
    id: String,
    content_hash: String,
    mime: String,
    size_bytes: i64,
    relative_path: String,
    logical_type: String,
    source_json: String,
    source_url: Option<String>,
    created_at: String,
}

impl TryFrom<ArtifactRow> for Artifact {
    type Error = anyhow::Error;

    fn try_from(row: ArtifactRow) -> Result<Self> {
        Ok(Self {
            id: Uuid::parse_str(&row.id)?,
            content_hash: row.content_hash,
            mime: row.mime,
            size_bytes: u64::try_from(row.size_bytes).context("negative artifact size")?,
            relative_path: row.relative_path,
            logical_type: enum_from_string(&row.logical_type)?,
            source: from_json(&row.source_json)?,
            source_url: row.source_url,
            created_at: DateTime::parse_from_rfc3339(&row.created_at)?.with_timezone(&Utc),
        })
    }
}

pub fn relative_path_for_hash(hash: &str) -> String {
    let prefix = hash.get(..2).unwrap_or("00");
    format!("{prefix}/{hash}")
}

fn is_data_uri(value: &str) -> bool {
    value
        .get(..5)
        .is_some_and(|prefix| prefix.eq_ignore_ascii_case("data:"))
}

fn decode_data_uri(value: &str) -> Result<(String, Vec<u8>)> {
    let (header, payload) = value
        .split_once(',')
        .context("invalid data URI: missing comma")?;
    if !header
        .get(..5)
        .is_some_and(|prefix| prefix.eq_ignore_ascii_case("data:"))
    {
        anyhow::bail!("invalid data URI");
    }
    let meta = &header[5..];
    let mut parts = meta.split(';');
    let mime = parts
        .next()
        .filter(|part| !part.is_empty())
        .unwrap_or("text/plain");
    let is_base64 = parts.any(|part| part.eq_ignore_ascii_case("base64"));
    if !is_base64 {
        bail!("only base64 data URIs are accepted for provider artifacts");
    }
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(payload)
        .context("invalid base64 data URI")?;
    Ok((mime.to_owned(), bytes))
}

fn redact_source_url(value: &str) -> String {
    reqwest::Url::parse(value)
        .map(|mut url| {
            url.set_query(None);
            url.set_fragment(None);
            url.to_string()
        })
        .unwrap_or_else(|_| value.to_owned())
}

#[cfg(test)]
mod tests {
    use tempfile::tempdir;

    use crate::db;

    use super::{relative_path_for_hash, ArtifactStore};

    #[tokio::test]
    async fn deduplicates_by_content_hash() {
        let pool = db::connect_memory().await.unwrap();
        let temp = tempdir().unwrap();
        let store = ArtifactStore::new(temp.path(), pool).await.unwrap();

        let first = store
            .import_bytes(b"same", "application/octet-stream", None)
            .await
            .unwrap();
        let second = store
            .import_bytes(b"same", "application/octet-stream", None)
            .await
            .unwrap();

        assert_eq!(first.id, second.id);
        assert_eq!(first.content_hash, second.content_hash);
        assert_eq!(
            first.relative_path,
            relative_path_for_hash(&first.content_hash)
        );
        assert!(store.absolute_path(&first).await.unwrap().exists());
    }

    #[tokio::test]
    async fn repairs_missing_file_when_content_is_reimported() {
        let pool = db::connect_memory().await.unwrap();
        let temp = tempdir().unwrap();
        let store = ArtifactStore::new(temp.path(), pool).await.unwrap();

        let artifact = store
            .import_bytes(b"repair-me", "application/octet-stream", None)
            .await
            .unwrap();
        let path = store.absolute_path(&artifact).await.unwrap();
        tokio::fs::remove_file(&path).await.unwrap();

        let repaired = store
            .import_bytes(b"repair-me", "application/octet-stream", None)
            .await
            .unwrap();

        assert_eq!(artifact.id, repaired.id);
        assert_eq!(tokio::fs::read(path).await.unwrap(), b"repair-me");
    }

    #[test]
    fn data_uri_detection_is_utf8_safe() {
        assert!(!super::is_data_uri("你好世界"));
        assert!(super::is_data_uri("data:text/plain;base64,QQ=="));
    }

    #[tokio::test]
    async fn imports_base64_data_uri() {
        let pool = db::connect_memory().await.unwrap();
        let temp = tempdir().unwrap();
        let store = ArtifactStore::new(temp.path(), pool).await.unwrap();

        let artifact = store
            .import_source("data:text/plain;base64,aGVsbG8=", None)
            .await
            .unwrap();

        assert_eq!(artifact.mime, "text/plain");
        assert_eq!(artifact.size_bytes, 5);
    }
}
