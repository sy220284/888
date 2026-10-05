PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS observation_analyses (
    id TEXT PRIMARY KEY NOT NULL,
    observation_id TEXT NOT NULL,
    source_artifact_id TEXT NOT NULL,
    status TEXT NOT NULL,
    preview_artifact_id TEXT,
    width INTEGER CHECK (width IS NULL OR width >= 1),
    height INTEGER CHECK (height IS NULL OR height >= 1),
    orientation INTEGER CHECK (orientation IS NULL OR (orientation >= 1 AND orientation <= 8)),
    captured_at TEXT,
    exif_json TEXT NOT NULL,
    quality_json TEXT NOT NULL,
    analyzer_version TEXT NOT NULL,
    error TEXT,
    analyzed_at TEXT NOT NULL,
    UNIQUE(observation_id, analyzer_version),
    FOREIGN KEY(observation_id) REFERENCES observations(id) ON DELETE CASCADE,
    FOREIGN KEY(source_artifact_id) REFERENCES artifacts(id) ON DELETE RESTRICT,
    FOREIGN KEY(preview_artifact_id) REFERENCES artifacts(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_observation_analyses_observation_time
    ON observation_analyses(observation_id, analyzed_at DESC);
