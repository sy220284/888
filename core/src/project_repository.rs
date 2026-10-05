use anyhow::{Context, Result};
use chrono::{DateTime, Utc};
use sqlx::SqlitePool;
use uuid::Uuid;

use crate::model::Project;

#[derive(Clone)]
pub struct ProjectRepository {
    pool: SqlitePool,
}

impl ProjectRepository {
    pub fn new(pool: SqlitePool) -> Self {
        Self { pool }
    }

    /// Replaces the legacy `project-state.mjs` file scanner for project identity.
    /// Derived world readiness is intentionally not inferred from directory contents;
    /// Canonical World State and Job State own those facts.
    pub async fn create(&self, slug: &str, display_name: &str) -> Result<Project> {
        validate_slug(slug)?;
        if display_name.trim().is_empty() {
            anyhow::bail!("display_name must not be empty");
        }

        let now = Utc::now();
        let record = Project {
            id: Uuid::new_v4(),
            slug: slug.to_owned(),
            display_name: display_name.trim().to_owned(),
            created_at: now,
            updated_at: now,
        };

        sqlx::query(
            r#"
            INSERT INTO projects(id, slug, display_name, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?)
            "#,
        )
        .bind(record.id.to_string())
        .bind(&record.slug)
        .bind(&record.display_name)
        .bind(record.created_at.to_rfc3339())
        .bind(record.updated_at.to_rfc3339())
        .execute(&self.pool)
        .await?;

        Ok(record)
    }

    pub async fn get_by_slug(&self, slug: &str) -> Result<Option<Project>> {
        let row = sqlx::query_as::<_, ProjectRow>(
            r#"
            SELECT id, slug, display_name, created_at, updated_at
            FROM projects
            WHERE slug = ?
            "#,
        )
        .bind(slug)
        .fetch_optional(&self.pool)
        .await?;

        row.map(TryInto::try_into).transpose()
    }
}

#[derive(sqlx::FromRow)]
struct ProjectRow {
    id: String,
    slug: String,
    display_name: String,
    created_at: String,
    updated_at: String,
}

impl TryFrom<ProjectRow> for Project {
    type Error = anyhow::Error;

    fn try_from(row: ProjectRow) -> Result<Self> {
        Ok(Self {
            id: Uuid::parse_str(&row.id)?,
            slug: row.slug,
            display_name: row.display_name,
            created_at: DateTime::parse_from_rfc3339(&row.created_at)
                .context("invalid project created_at")?
                .with_timezone(&Utc),
            updated_at: DateTime::parse_from_rfc3339(&row.updated_at)
                .context("invalid project updated_at")?
                .with_timezone(&Utc),
        })
    }
}

fn validate_slug(slug: &str) -> Result<()> {
    if slug.is_empty() || slug.len() > 80 {
        anyhow::bail!("slug must contain 1..=80 characters");
    }
    let valid_chars = slug
        .bytes()
        .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'-');
    if !valid_chars || slug.starts_with('-') || slug.ends_with('-') || slug.contains("--") {
        anyhow::bail!("slug must match ^[a-z0-9]+(?:-[a-z0-9]+)*$");
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use crate::db;

    use super::{validate_slug, ProjectRepository};

    #[test]
    fn slug_validation_matches_schema_pattern() {
        for valid in ["demo", "demo-world", "world2-a"] {
            assert!(validate_slug(valid).is_ok(), "{valid}");
        }
        for invalid in ["-demo", "demo-", "demo--world", "Demo", "demo_world"] {
            assert!(validate_slug(invalid).is_err(), "{invalid}");
        }
    }

    #[tokio::test]
    async fn stores_project_identity_in_sqlite_instead_of_scanning_directories() {
        let pool = db::connect_memory().await.unwrap();
        let repo = ProjectRepository::new(pool);

        let created = repo.create("demo-world", "Demo World").await.unwrap();
        let loaded = repo.get_by_slug("demo-world").await.unwrap().unwrap();

        assert_eq!(created.id, loaded.id);
        assert_eq!(loaded.display_name, "Demo World");
    }
}
