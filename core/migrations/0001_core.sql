PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS projects (
    id TEXT PRIMARY KEY NOT NULL,
    slug TEXT NOT NULL UNIQUE,
    display_name TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS artifacts (
    id TEXT PRIMARY KEY NOT NULL,
    content_hash TEXT NOT NULL UNIQUE,
    mime TEXT NOT NULL,
    size_bytes INTEGER NOT NULL CHECK (size_bytes >= 0),
    relative_path TEXT NOT NULL UNIQUE,
    source_url TEXT,
    created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS ai_provider_runs (
    id TEXT PRIMARY KEY NOT NULL,
    capability TEXT NOT NULL,
    provider TEXT NOT NULL,
    endpoint TEXT NOT NULL,
    status TEXT NOT NULL,
    request_id TEXT,
    input_json TEXT NOT NULL,
    status_json TEXT,
    result_json TEXT,
    output_artifact_ids_json TEXT,
    error TEXT,
    submitted_at TEXT,
    completed_at TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_ai_provider_runs_provider_status
    ON ai_provider_runs(provider, status);
CREATE INDEX IF NOT EXISTS idx_ai_provider_runs_request_id
    ON ai_provider_runs(request_id);
