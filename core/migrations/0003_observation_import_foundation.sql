PRAGMA foreign_keys = ON;

ALTER TABLE artifacts
    ADD COLUMN logical_type TEXT NOT NULL DEFAULT 'OTHER';

ALTER TABLE artifacts
    ADD COLUMN source_json TEXT NOT NULL DEFAULT '{}';

CREATE INDEX IF NOT EXISTS idx_artifacts_logical_type
    ON artifacts(logical_type);

ALTER TABLE jobs
    ADD COLUMN input_json TEXT NOT NULL DEFAULT '{}';
