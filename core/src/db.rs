use std::path::Path;

use anyhow::Result;
use sqlx::{
    sqlite::{SqliteConnectOptions, SqlitePoolOptions},
    SqlitePool,
};

pub async fn connect(database_url: &str) -> Result<SqlitePool> {
    let pool = SqlitePoolOptions::new()
        .max_connections(8)
        .connect(database_url)
        .await?;
    sqlx::migrate!().run(&pool).await?;
    Ok(pool)
}

pub async fn connect_path(path: impl AsRef<Path>) -> Result<SqlitePool> {
    let path = path.as_ref();
    if let Some(parent) = path.parent() {
        tokio::fs::create_dir_all(parent).await?;
    }

    let options = SqliteConnectOptions::new()
        .filename(path)
        .create_if_missing(true)
        .foreign_keys(true);
    let pool = SqlitePoolOptions::new()
        .max_connections(8)
        .connect_with(options)
        .await?;
    sqlx::migrate!().run(&pool).await?;
    Ok(pool)
}

pub async fn connect_memory() -> Result<SqlitePool> {
    let options = SqliteConnectOptions::new()
        .filename(":memory:")
        .foreign_keys(true);
    let pool = SqlitePoolOptions::new()
        .max_connections(1)
        .connect_with(options)
        .await?;
    sqlx::migrate!().run(&pool).await?;
    Ok(pool)
}

#[cfg(test)]
mod tests {
    use tempfile::tempdir;

    use super::connect_path;

    #[tokio::test]
    async fn connect_path_creates_database_and_runs_migrations() {
        let temp = tempdir().unwrap();
        let path = temp.path().join("nested").join("world888.sqlite3");

        let pool = connect_path(&path).await.unwrap();
        let table_count: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = 'worlds'",
        )
        .fetch_one(&pool)
        .await
        .unwrap();

        assert_eq!(table_count, 1);
        assert!(path.exists());
    }
}
