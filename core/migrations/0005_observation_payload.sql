PRAGMA foreign_keys = ON;

ALTER TABLE observations
    ADD COLUMN payload_json TEXT NOT NULL DEFAULT '{}';
