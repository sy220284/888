PRAGMA foreign_keys = ON;

ALTER TABLE worlds
    ADD COLUMN created_by_command_id TEXT REFERENCES commands(command_id) ON DELETE SET NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_worlds_created_by_command_unique
    ON worlds(created_by_command_id)
    WHERE created_by_command_id IS NOT NULL;

ALTER TABLE commands ADD COLUMN execution_owner TEXT;
ALTER TABLE commands ADD COLUMN lease_expires_at TEXT;
ALTER TABLE commands ADD COLUMN execution_attempt INTEGER NOT NULL DEFAULT 0 CHECK (execution_attempt >= 0);

CREATE INDEX IF NOT EXISTS idx_commands_incomplete_lease
    ON commands(response_json, lease_expires_at);

ALTER TABLE jobs
    ADD COLUMN assigned_worker_id TEXT REFERENCES worker_registrations(worker_id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_jobs_assigned_worker_state
    ON jobs(assigned_worker_id, state);

CREATE TABLE IF NOT EXISTS job_events (
    id TEXT PRIMARY KEY NOT NULL,
    job_id TEXT NOT NULL,
    event_type TEXT NOT NULL,
    payload_json TEXT NOT NULL,
    created_at TEXT NOT NULL,
    FOREIGN KEY(job_id) REFERENCES jobs(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_job_events_job_created
    ON job_events(job_id, created_at);
