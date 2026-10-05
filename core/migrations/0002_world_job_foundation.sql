PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS worlds (
    id TEXT PRIMARY KEY NOT NULL,
    name TEXT NOT NULL,
    schema_version INTEGER NOT NULL CHECK (schema_version >= 1),
    active_revision_id TEXT,
    coordinate_system TEXT NOT NULL,
    unit TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS commands (
    command_id TEXT PRIMARY KEY NOT NULL,
    type TEXT NOT NULL,
    world_id TEXT,
    payload_json TEXT NOT NULL,
    schema_version INTEGER NOT NULL CHECK (schema_version >= 1),
    caller_context_json TEXT NOT NULL,
    requested_at TEXT NOT NULL,
    status TEXT NOT NULL,
    response_json TEXT,
    FOREIGN KEY(world_id) REFERENCES worlds(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS world_revisions (
    id TEXT PRIMARY KEY NOT NULL,
    world_id TEXT NOT NULL,
    parent_revision_id TEXT,
    command_id TEXT,
    actor_type TEXT NOT NULL,
    changeset_json TEXT NOT NULL,
    created_at TEXT NOT NULL,
    FOREIGN KEY(world_id) REFERENCES worlds(id) ON DELETE CASCADE,
    FOREIGN KEY(parent_revision_id) REFERENCES world_revisions(id) ON DELETE RESTRICT,
    FOREIGN KEY(command_id) REFERENCES commands(command_id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_world_revisions_world_created
    ON world_revisions(world_id, created_at);

CREATE TABLE IF NOT EXISTS observations (
    id TEXT PRIMARY KEY NOT NULL,
    world_id TEXT NOT NULL,
    artifact_id TEXT,
    source_type TEXT NOT NULL,
    timestamp TEXT,
    camera_intrinsics_json TEXT,
    camera_pose_candidate_json TEXT,
    quality_json TEXT NOT NULL,
    immutable INTEGER NOT NULL CHECK (immutable IN (0, 1)),
    created_at TEXT NOT NULL,
    FOREIGN KEY(world_id) REFERENCES worlds(id) ON DELETE CASCADE,
    FOREIGN KEY(artifact_id) REFERENCES artifacts(id) ON DELETE RESTRICT
);

CREATE TABLE IF NOT EXISTS evidence (
    id TEXT PRIMARY KEY NOT NULL,
    world_id TEXT NOT NULL,
    type TEXT NOT NULL,
    subject_ref TEXT NOT NULL,
    object_ref TEXT NOT NULL,
    source_job_id TEXT,
    weight REAL NOT NULL CHECK (weight >= 0 AND weight <= 1),
    confidence REAL CHECK (confidence IS NULL OR (confidence >= 0 AND confidence <= 1)),
    payload_json TEXT NOT NULL,
    created_at TEXT NOT NULL,
    invalidated_at TEXT,
    FOREIGN KEY(world_id) REFERENCES worlds(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_evidence_world_type
    ON evidence(world_id, type);

CREATE TABLE IF NOT EXISTS associative_proposals (
    id TEXT PRIMARY KEY NOT NULL,
    world_id TEXT NOT NULL,
    prior_type TEXT NOT NULL,
    subject_ref TEXT NOT NULL,
    target_ref TEXT NOT NULL,
    score REAL NOT NULL CHECK (score >= 0 AND score <= 1),
    uncertainty REAL NOT NULL CHECK (uncertainty >= 0 AND uncertainty <= 1),
    supporting_evidence_ids_json TEXT NOT NULL,
    contradicting_evidence_ids_json TEXT NOT NULL,
    source TEXT NOT NULL,
    source_version TEXT NOT NULL,
    created_by_job_id TEXT,
    state TEXT NOT NULL,
    created_at TEXT NOT NULL,
    FOREIGN KEY(world_id) REFERENCES worlds(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_associative_proposals_world_state
    ON associative_proposals(world_id, state);

CREATE TABLE IF NOT EXISTS hypotheses (
    id TEXT PRIMARY KEY NOT NULL,
    world_id TEXT NOT NULL,
    hypothesis_type TEXT NOT NULL,
    status TEXT NOT NULL,
    score REAL NOT NULL CHECK (score >= 0 AND score <= 1),
    uncertainty REAL NOT NULL CHECK (uncertainty >= 0 AND uncertainty <= 1),
    payload_json TEXT NOT NULL,
    supporting_evidence_ids_json TEXT NOT NULL,
    contradicting_evidence_ids_json TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    FOREIGN KEY(world_id) REFERENCES worlds(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS zones (
    id TEXT PRIMARY KEY NOT NULL,
    world_id TEXT NOT NULL,
    zone_type TEXT NOT NULL,
    display_name TEXT,
    local_transform_json TEXT NOT NULL,
    confidence REAL CHECK (confidence IS NULL OR (confidence >= 0 AND confidence <= 1)),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    FOREIGN KEY(world_id) REFERENCES worlds(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS anchors (
    id TEXT PRIMARY KEY NOT NULL,
    world_id TEXT NOT NULL,
    anchor_type TEXT NOT NULL,
    zone_id TEXT,
    local_pose_json TEXT NOT NULL,
    confidence REAL CHECK (confidence IS NULL OR (confidence >= 0 AND confidence <= 1)),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    FOREIGN KEY(world_id) REFERENCES worlds(id) ON DELETE CASCADE,
    FOREIGN KEY(zone_id) REFERENCES zones(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS portals (
    id TEXT PRIMARY KEY NOT NULL,
    world_id TEXT NOT NULL,
    from_zone_id TEXT NOT NULL,
    to_zone_id TEXT,
    anchor_id TEXT,
    transform_json TEXT NOT NULL,
    passable INTEGER NOT NULL CHECK (passable IN (0, 1)),
    confidence REAL NOT NULL CHECK (confidence >= 0 AND confidence <= 1),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    CHECK (to_zone_id IS NULL OR to_zone_id != from_zone_id),
    FOREIGN KEY(world_id) REFERENCES worlds(id) ON DELETE CASCADE,
    FOREIGN KEY(from_zone_id) REFERENCES zones(id) ON DELETE RESTRICT,
    FOREIGN KEY(to_zone_id) REFERENCES zones(id) ON DELETE SET NULL,
    FOREIGN KEY(anchor_id) REFERENCES anchors(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS entities (
    id TEXT PRIMARY KEY NOT NULL,
    world_id TEXT NOT NULL,
    semantic_class TEXT NOT NULL,
    display_name TEXT,
    zone_id TEXT,
    transform_json TEXT NOT NULL,
    scale_json TEXT NOT NULL,
    physical_properties_json TEXT NOT NULL,
    lifecycle TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    FOREIGN KEY(world_id) REFERENCES worlds(id) ON DELETE CASCADE,
    FOREIGN KEY(zone_id) REFERENCES zones(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS geometry_representations (
    id TEXT PRIMARY KEY NOT NULL,
    world_id TEXT NOT NULL,
    entity_id TEXT,
    zone_id TEXT,
    representation_type TEXT NOT NULL,
    artifact_id TEXT NOT NULL,
    quality_profile TEXT,
    source_kind TEXT NOT NULL,
    valid_region_json TEXT,
    lod_level INTEGER CHECK (lod_level IS NULL OR lod_level >= 0),
    verification_state TEXT NOT NULL,
    created_at TEXT NOT NULL,
    CHECK (
        (entity_id IS NOT NULL AND zone_id IS NULL)
        OR (entity_id IS NULL AND zone_id IS NOT NULL)
    ),
    FOREIGN KEY(world_id) REFERENCES worlds(id) ON DELETE CASCADE,
    FOREIGN KEY(entity_id) REFERENCES entities(id) ON DELETE CASCADE,
    FOREIGN KEY(zone_id) REFERENCES zones(id) ON DELETE CASCADE,
    FOREIGN KEY(artifact_id) REFERENCES artifacts(id) ON DELETE RESTRICT
);

CREATE TABLE IF NOT EXISTS jobs (
    id TEXT PRIMARY KEY NOT NULL,
    world_id TEXT,
    task_type TEXT NOT NULL,
    state TEXT NOT NULL,
    attempt INTEGER NOT NULL CHECK (attempt >= 0),
    max_attempts INTEGER NOT NULL CHECK (max_attempts >= 1),
    idempotent INTEGER NOT NULL CHECK (idempotent IN (0, 1)),
    checkpoint_artifact_id TEXT,
    provider_run_id TEXT,
    error_code TEXT,
    error_payload_json TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    FOREIGN KEY(world_id) REFERENCES worlds(id) ON DELETE CASCADE,
    FOREIGN KEY(checkpoint_artifact_id) REFERENCES artifacts(id) ON DELETE SET NULL,
    FOREIGN KEY(provider_run_id) REFERENCES ai_provider_runs(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_jobs_state_updated
    ON jobs(state, updated_at);

CREATE TABLE IF NOT EXISTS job_dependencies (
    job_id TEXT NOT NULL,
    dependency_job_id TEXT NOT NULL,
    optional INTEGER NOT NULL CHECK (optional IN (0, 1)),
    PRIMARY KEY(job_id, dependency_job_id),
    FOREIGN KEY(job_id) REFERENCES jobs(id) ON DELETE CASCADE,
    FOREIGN KEY(dependency_job_id) REFERENCES jobs(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS candidates (
    id TEXT PRIMARY KEY NOT NULL,
    world_id TEXT NOT NULL,
    candidate_type TEXT NOT NULL,
    source_job_id TEXT,
    provider_run_id TEXT,
    artifact_ids_json TEXT NOT NULL,
    payload_json TEXT NOT NULL,
    status TEXT NOT NULL,
    created_at TEXT NOT NULL,
    FOREIGN KEY(world_id) REFERENCES worlds(id) ON DELETE CASCADE,
    FOREIGN KEY(source_job_id) REFERENCES jobs(id) ON DELETE SET NULL,
    FOREIGN KEY(provider_run_id) REFERENCES ai_provider_runs(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_candidates_world_status
    ON candidates(world_id, status);

CREATE TABLE IF NOT EXISTS validation_results (
    id TEXT PRIMARY KEY NOT NULL,
    candidate_id TEXT NOT NULL,
    status TEXT NOT NULL,
    issues_json TEXT NOT NULL,
    metrics_json TEXT NOT NULL,
    validator TEXT NOT NULL,
    created_at TEXT NOT NULL,
    FOREIGN KEY(candidate_id) REFERENCES candidates(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_validation_results_candidate
    ON validation_results(candidate_id, created_at);

CREATE TABLE IF NOT EXISTS worker_registrations (
    worker_id TEXT PRIMARY KEY NOT NULL,
    worker_type TEXT NOT NULL,
    protocol_version INTEGER NOT NULL CHECK (protocol_version >= 1),
    capabilities_json TEXT NOT NULL,
    device_json TEXT NOT NULL,
    software_json TEXT NOT NULL,
    health TEXT NOT NULL,
    current_job_ids_json TEXT NOT NULL DEFAULT '[]',
    cpu_usage REAL,
    ram_mb INTEGER,
    gpu_usage REAL,
    vram_mb INTEGER,
    last_heartbeat_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);


CREATE UNIQUE INDEX IF NOT EXISTS idx_world_revisions_command_unique
    ON world_revisions(command_id)
    WHERE command_id IS NOT NULL;

CREATE TRIGGER IF NOT EXISTS trg_world_active_revision_belongs_to_world
BEFORE UPDATE OF active_revision_id ON worlds
WHEN NEW.active_revision_id IS NOT NULL
     AND NOT EXISTS (
         SELECT 1
         FROM world_revisions
         WHERE id = NEW.active_revision_id
           AND world_id = NEW.id
     )
BEGIN
    SELECT RAISE(ABORT, 'active revision must belong to world');
END;

CREATE TRIGGER IF NOT EXISTS trg_revision_command_world_matches
BEFORE INSERT ON world_revisions
WHEN NEW.command_id IS NOT NULL
     AND EXISTS (
         SELECT 1
         FROM commands
         WHERE command_id = NEW.command_id
           AND world_id IS NOT NULL
           AND world_id != NEW.world_id
     )
BEGIN
    SELECT RAISE(ABORT, 'revision command world mismatch');
END;

CREATE TRIGGER IF NOT EXISTS trg_validation_requires_pending_candidate
BEFORE INSERT ON validation_results
WHEN NOT EXISTS (
    SELECT 1
    FROM candidates
    WHERE id = NEW.candidate_id
      AND status = 'PENDING'
)
BEGIN
    SELECT RAISE(ABORT, 'validation requires pending candidate');
END;

CREATE TRIGGER IF NOT EXISTS trg_evidence_source_job_exists
BEFORE INSERT ON evidence
WHEN NEW.source_job_id IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM jobs WHERE id = NEW.source_job_id)
BEGIN
    SELECT RAISE(ABORT, 'evidence source job does not exist');
END;

CREATE TRIGGER IF NOT EXISTS trg_proposal_source_job_exists
BEFORE INSERT ON associative_proposals
WHEN NEW.created_by_job_id IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM jobs WHERE id = NEW.created_by_job_id)
BEGIN
    SELECT RAISE(ABORT, 'proposal source job does not exist');
END;
