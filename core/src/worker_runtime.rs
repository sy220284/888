use std::{
    collections::HashMap,
    path::PathBuf,
    process::Stdio,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex as StdMutex,
    },
    time::Duration as StdDuration,
};

use anyhow::{bail, Context, Result};
use chrono::{DateTime, Duration, Utc};
use serde_json::{json, Value};
use sqlx::SqlitePool;
use tokio::{
    io::{AsyncBufReadExt, AsyncWriteExt, BufReader},
    process::Command as TokioCommand,
    sync::{mpsc, RwLock},
    time,
};
use uuid::Uuid;

use crate::{
    artifact_store::ArtifactStore,
    job_engine::JobEngine,
    model::{
        ArtifactLogicalType, Job, JobDispatch, JobResult, JobResultState, JobState, ProgressEvent,
        WorkerHeartbeat, WorkerMessage, WorkerMessageMessageType, WorkerRegistration,
    },
    observation_repository::ObservationRepository,
    worker_protocol::{decode_message, encode_message, WORKER_PROTOCOL_VERSION},
    worker_registry::WorkerRegistry,
};

const SCHEDULER_INTERVAL_MS: u64 = 250;
const LOST_SCAN_INTERVAL_SECONDS: u64 = 5;
const WORKER_LOST_AFTER_SECONDS: i64 = 15;

#[derive(Debug, Clone)]
pub struct WorkerSpec {
    pub name: String,
    pub program: String,
    pub args: Vec<String>,
    pub current_dir: PathBuf,
    pub env: Vec<(String, String)>,
}

impl WorkerSpec {
    pub fn python_module(
        name: impl Into<String>,
        python: impl Into<String>,
        module: impl Into<String>,
        current_dir: impl Into<PathBuf>,
        artifact_root: impl Into<PathBuf>,
    ) -> Self {
        let current_dir = current_dir.into();
        let artifact_root = artifact_root.into();
        Self {
            name: name.into(),
            program: python.into(),
            args: vec!["-m".to_owned(), module.into()],
            env: vec![
                (
                    "PYTHONPATH".to_owned(),
                    current_dir.to_string_lossy().into_owned(),
                ),
                (
                    "WORLD888_ARTIFACT_ROOT".to_owned(),
                    artifact_root.to_string_lossy().into_owned(),
                ),
            ],
            current_dir,
        }
    }
}

#[derive(Debug, Clone)]
pub enum RuntimeControl {
    Pause(Uuid),
    Cancel(Uuid),
}

pub type RuntimeControlSender = mpsc::UnboundedSender<RuntimeControl>;

#[derive(Clone)]
pub struct WorkerRuntime {
    inner: Arc<WorkerRuntimeInner>,
    control_tx: RuntimeControlSender,
}

struct WorkerRuntimeInner {
    jobs: JobEngine,
    registry: WorkerRegistry,
    artifacts: ArtifactStore,
    observations: ObservationRepository,
    workers: RwLock<HashMap<Uuid, WorkerHandle>>,
    shutting_down: AtomicBool,
}

#[derive(Clone)]
struct WorkerHandle {
    capabilities: Vec<String>,
    tx: mpsc::UnboundedSender<WorkerMessage>,
    busy: Arc<AtomicBool>,
}

impl WorkerRuntime {
    pub async fn start(
        pool: SqlitePool,
        artifacts: ArtifactStore,
        specs: Vec<WorkerSpec>,
    ) -> Result<Self> {
        let jobs = JobEngine::new(pool.clone());
        jobs.recover_interrupted().await?;

        let inner = Arc::new(WorkerRuntimeInner {
            jobs,
            registry: WorkerRegistry::new(pool.clone()),
            artifacts,
            observations: ObservationRepository::new(pool),
            workers: RwLock::new(HashMap::new()),
            shutting_down: AtomicBool::new(false),
        });
        let (control_tx, control_rx) = mpsc::unbounded_channel();
        let runtime = Self { inner, control_tx };

        runtime.spawn_control_loop(control_rx);
        runtime.spawn_scheduler_loop();
        runtime.spawn_liveness_loop();

        for spec in specs {
            if let Err(error) = runtime.spawn_worker(spec.clone()).await {
                tracing::warn!(
                    worker = %spec.name,
                    error = %error,
                    "worker process failed to start; desktop remains available"
                );
            }
        }

        Ok(runtime)
    }

    pub fn control_sender(&self) -> RuntimeControlSender {
        self.control_tx.clone()
    }

    pub async fn worker_count(&self) -> usize {
        self.inner.workers.read().await.len()
    }

    pub async fn shutdown(&self) {
        if self.inner.shutting_down.swap(true, Ordering::SeqCst) {
            return;
        }
        let handles = self
            .inner
            .workers
            .read()
            .await
            .values()
            .cloned()
            .collect::<Vec<_>>();
        for handle in handles {
            let _ = handle.tx.send(WorkerMessage {
                message_id: Uuid::new_v4(),
                message_type: WorkerMessageMessageType::Shutdown,
                protocol_version: WORKER_PROTOCOL_VERSION,
                job_id: None,
                payload: json!({}),
            });
        }
    }

    async fn spawn_worker(&self, spec: WorkerSpec) -> Result<()> {
        let mut command = TokioCommand::new(&spec.program);
        command
            .args(&spec.args)
            .current_dir(&spec.current_dir)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        for (key, value) in &spec.env {
            command.env(key, value);
        }

        let mut child = command
            .spawn()
            .with_context(|| format!("failed to spawn worker {}", spec.name))?;
        let stdin = child.stdin.take().context("worker stdin missing")?;
        let stdout = child.stdout.take().context("worker stdout missing")?;
        let stderr = child.stderr.take().context("worker stderr missing")?;

        let (tx, mut rx) = mpsc::unbounded_channel::<WorkerMessage>();
        let worker_id = Arc::new(StdMutex::new(None::<Uuid>));

        let writer_name = spec.name.clone();
        tokio::spawn(async move {
            let mut stdin = stdin;
            while let Some(message) = rx.recv().await {
                match encode_message(&message) {
                    Ok(encoded) => {
                        if let Err(error) = stdin.write_all(encoded.as_bytes()).await {
                            tracing::warn!(worker = %writer_name, error = %error, "worker stdin write failed");
                            break;
                        }
                        if let Err(error) = stdin.flush().await {
                            tracing::warn!(worker = %writer_name, error = %error, "worker stdin flush failed");
                            break;
                        }
                    }
                    Err(error) => {
                        tracing::warn!(worker = %writer_name, error = %error, "worker message encoding failed");
                    }
                }
            }
        });

        let reader_inner = Arc::clone(&self.inner);
        let reader_tx = tx.clone();
        let reader_id = Arc::clone(&worker_id);
        let reader_name = spec.name.clone();
        tokio::spawn(async move {
            let mut lines = BufReader::new(stdout).lines();
            loop {
                match lines.next_line().await {
                    Ok(Some(line)) => {
                        let message = match decode_message(&line) {
                            Ok(message) => message,
                            Err(error) => {
                                tracing::warn!(worker = %reader_name, error = %error, "invalid worker protocol message");
                                continue;
                            }
                        };
                        if let Err(error) = reader_inner
                            .handle_worker_message(
                                message,
                                reader_tx.clone(),
                                Arc::clone(&reader_id),
                            )
                            .await
                        {
                            tracing::warn!(worker = %reader_name, error = %error, "worker message handling failed");
                        }
                    }
                    Ok(None) => break,
                    Err(error) => {
                        tracing::warn!(worker = %reader_name, error = %error, "worker stdout read failed");
                        break;
                    }
                }
            }

            let id = reader_id.lock().ok().and_then(|guard| *guard);
            if let Some(id) = id {
                reader_inner.workers.write().await.remove(&id);
                if let Err(error) = reader_inner.jobs.recover_worker_lost(id).await {
                    tracing::warn!(worker_id = %id, error = %error, "failed to recover jobs after worker exit");
                }
            }
        });

        let stderr_name = spec.name.clone();
        tokio::spawn(async move {
            let mut lines = BufReader::new(stderr).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                tracing::info!(worker = %stderr_name, message = %line, "worker stderr");
            }
        });

        tokio::spawn(async move {
            if let Err(error) = child.wait().await {
                tracing::warn!(worker = %spec.name, error = %error, "worker wait failed");
            }
        });

        Ok(())
    }

    fn spawn_scheduler_loop(&self) {
        let inner = Arc::clone(&self.inner);
        tokio::spawn(async move {
            let mut ticker = time::interval(StdDuration::from_millis(SCHEDULER_INTERVAL_MS));
            loop {
                ticker.tick().await;
                if inner.shutting_down.load(Ordering::SeqCst) {
                    break;
                }
                if let Err(error) = inner.dispatch_ready_jobs().await {
                    tracing::warn!(error = %error, "worker scheduler tick failed");
                }
            }
        });
    }

    fn spawn_liveness_loop(&self) {
        let inner = Arc::clone(&self.inner);
        tokio::spawn(async move {
            let mut ticker = time::interval(StdDuration::from_secs(LOST_SCAN_INTERVAL_SECONDS));
            loop {
                ticker.tick().await;
                if inner.shutting_down.load(Ordering::SeqCst) {
                    break;
                }
                let cutoff = Utc::now() - Duration::seconds(WORKER_LOST_AFTER_SECONDS);
                match inner.registry.mark_lost_workers_before(cutoff).await {
                    Ok(lost) => {
                        if !lost.is_empty() {
                            let mut workers = inner.workers.write().await;
                            for worker_id in lost {
                                workers.remove(&worker_id);
                                tracing::warn!(worker_id = %worker_id, "worker heartbeat timed out");
                            }
                        }
                    }
                    Err(error) => tracing::warn!(error = %error, "worker lost scan failed"),
                }
            }
        });
    }

    fn spawn_control_loop(&self, mut rx: mpsc::UnboundedReceiver<RuntimeControl>) {
        let inner = Arc::clone(&self.inner);
        tokio::spawn(async move {
            while let Some(control) = rx.recv().await {
                if inner.shutting_down.load(Ordering::SeqCst) {
                    break;
                }
                if let Err(error) = inner.send_control(control).await {
                    tracing::warn!(error = %error, "worker control dispatch failed");
                }
            }
        });
    }
}

impl WorkerRuntimeInner {
    async fn handle_worker_message(
        &self,
        message: WorkerMessage,
        outbound: mpsc::UnboundedSender<WorkerMessage>,
        source_worker_id: Arc<StdMutex<Option<Uuid>>>,
    ) -> Result<()> {
        match message.message_type {
            WorkerMessageMessageType::Register => {
                let registration: WorkerRegistration = serde_json::from_value(message.payload)?;
                {
                    let mut guard = source_worker_id
                        .lock()
                        .map_err(|_| anyhow::anyhow!("worker identity lock poisoned"))?;
                    if let Some(existing) = *guard {
                        if existing != registration.worker_id {
                            bail!("worker process attempted to change worker_id");
                        }
                    } else {
                        *guard = Some(registration.worker_id);
                    }
                }
                self.registry.register(&registration).await?;
                self.workers.write().await.insert(
                    registration.worker_id,
                    WorkerHandle {
                        capabilities: registration.capabilities,
                        tx: outbound,
                        busy: Arc::new(AtomicBool::new(false)),
                    },
                );
            }
            WorkerMessageMessageType::Heartbeat => {
                let heartbeat: WorkerHeartbeat = serde_json::from_value(message.payload)?;
                ensure_source_worker(&source_worker_id, heartbeat.worker_id)?;
                self.registry.heartbeat(&heartbeat).await?;
            }
            WorkerMessageMessageType::Progress => {
                let worker_id = source_id(&source_worker_id)?;
                let event: ProgressEvent = serde_json::from_value(message.payload)?;
                if Some(event.job_id) != message.job_id {
                    bail!("progress job_id envelope mismatch");
                }
                let job = self
                    .jobs
                    .get(event.job_id)
                    .await?
                    .context("progress references unknown job")?;
                if job.assigned_worker_id != Some(worker_id) {
                    bail!("progress came from worker that does not own the job");
                }
                self.jobs
                    .record_event(event.job_id, "PROGRESS", serde_json::to_value(event)?)
                    .await?;
            }
            WorkerMessageMessageType::JobResult => {
                let worker_id = source_id(&source_worker_id)?;
                let result: JobResult = serde_json::from_value(message.payload)?;
                if Some(result.job_id) != message.job_id {
                    bail!("job result envelope mismatch");
                }
                self.handle_job_result(worker_id, result).await?;
            }
            WorkerMessageMessageType::Shutdown
            | WorkerMessageMessageType::JobDispatch
            | WorkerMessageMessageType::Pause
            | WorkerMessageMessageType::Cancel => {
                bail!("unexpected worker-to-core message type");
            }
        }
        Ok(())
    }

    async fn dispatch_ready_jobs(&self) -> Result<()> {
        let jobs = self.jobs.list_ready(32).await?;
        for job in jobs {
            let Some((worker_id, handle)) = self.claim_idle_worker(&job.task_type).await else {
                continue;
            };

            let dispatch = match self.prepare_dispatch(&job).await {
                Ok(dispatch) => dispatch,
                Err(error) => {
                    handle.busy.store(false, Ordering::SeqCst);
                    self.jobs
                        .fail(
                            job.id,
                            "INVALID_INPUT",
                            Some(json!({"message": error.to_string()})),
                        )
                        .await?;
                    continue;
                }
            };

            if let Err(error) = self.jobs.start_on_worker(job.id, worker_id).await {
                handle.busy.store(false, Ordering::SeqCst);
                tracing::debug!(job_id = %job.id, error = %error, "job was no longer dispatchable");
                continue;
            }

            let message = WorkerMessage {
                message_id: Uuid::new_v4(),
                message_type: WorkerMessageMessageType::JobDispatch,
                protocol_version: WORKER_PROTOCOL_VERSION,
                job_id: Some(job.id),
                payload: serde_json::to_value(dispatch)?,
            };
            if handle.tx.send(message).is_err() {
                handle.busy.store(false, Ordering::SeqCst);
                self.workers.write().await.remove(&worker_id);
                self.jobs.recover_worker_lost(worker_id).await?;
            }
        }
        Ok(())
    }

    async fn claim_idle_worker(&self, task_type: &str) -> Option<(Uuid, WorkerHandle)> {
        let workers = self.workers.read().await;
        for (worker_id, handle) in workers.iter() {
            if !handle
                .capabilities
                .iter()
                .any(|capability| capability == task_type)
            {
                continue;
            }
            if handle
                .busy
                .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
                .is_ok()
            {
                return Some((*worker_id, handle.clone()));
            }
        }
        None
    }

    async fn prepare_dispatch(&self, job: &Job) -> Result<JobDispatch> {
        let mut parameters = job.input.clone();
        let object = parameters
            .as_object_mut()
            .context("job input must remain an object")?;
        let mut artifact_ids = Vec::new();

        if let Some(value) = object.get("artifact_id").and_then(Value::as_str) {
            let artifact_id = Uuid::parse_str(value).context("invalid job artifact_id")?;
            artifact_ids.push(artifact_id);
            if job.task_type == "ANALYZE_OBSERVATION" {
                let artifact = self
                    .artifacts
                    .get(artifact_id)
                    .await?
                    .context("analysis artifact does not exist")?;
                object.insert(
                    "artifact_token".to_owned(),
                    Value::String(artifact.relative_path.clone()),
                );
            }
        }
        if let Some(values) = object.get("artifact_ids").and_then(Value::as_array) {
            for value in values {
                let artifact_id = value
                    .as_str()
                    .context("artifact_ids must contain UUID strings")
                    .and_then(|value| Uuid::parse_str(value).map_err(Into::into))?;
                if !artifact_ids.contains(&artifact_id) {
                    artifact_ids.push(artifact_id);
                }
            }
        }

        Ok(JobDispatch {
            job_id: job.id,
            protocol_version: WORKER_PROTOCOL_VERSION,
            r#type: job.task_type.clone(),
            input_refs: artifact_ids
                .iter()
                .map(|artifact_id| format!("artifact:{artifact_id}"))
                .collect(),
            parameters,
            artifact_ids,
            checkpoint_artifact_id: job.checkpoint_artifact_id,
        })
    }

    async fn send_control(&self, control: RuntimeControl) -> Result<()> {
        let (job_id, message_type) = match control {
            RuntimeControl::Pause(job_id) => (job_id, WorkerMessageMessageType::Pause),
            RuntimeControl::Cancel(job_id) => (job_id, WorkerMessageMessageType::Cancel),
        };
        let job = self.jobs.get(job_id).await?.context("job does not exist")?;
        let Some(worker_id) = job.assigned_worker_id else {
            return Ok(());
        };
        let handle = self
            .workers
            .read()
            .await
            .get(&worker_id)
            .cloned()
            .context("assigned worker is not available")?;
        handle
            .tx
            .send(WorkerMessage {
                message_id: Uuid::new_v4(),
                message_type,
                protocol_version: WORKER_PROTOCOL_VERSION,
                job_id: Some(job_id),
                payload: json!({}),
            })
            .map_err(|_| anyhow::anyhow!("worker control channel closed"))
    }

    async fn handle_job_result(&self, worker_id: Uuid, result: JobResult) -> Result<()> {
        let current = self
            .jobs
            .get(result.job_id)
            .await?
            .context("job result references unknown job")?;
        if current.assigned_worker_id != Some(worker_id) {
            if matches!(
                current.state,
                JobState::Cancelled | JobState::Completed | JobState::Failed
            ) {
                self.release_worker(worker_id).await;
                return Ok(());
            }
            bail!("job result came from worker that does not own the job");
        }

        self.jobs
            .record_event(result.job_id, "JOB_RESULT", serde_json::to_value(&result)?)
            .await?;

        match result.state {
            JobResultState::Completed => {
                if current.task_type == "ANALYZE_OBSERVATION" {
                    if let Err(error) = self.apply_observation_analysis(&current, &result).await {
                        self.jobs
                            .fail(
                                current.id,
                                "INVALID_WORKER_OUTPUT",
                                Some(json!({"message": error.to_string()})),
                            )
                            .await?;
                        self.release_worker(worker_id).await;
                        return Ok(());
                    }
                }
                self.jobs
                    .transition(current.id, JobState::Completed)
                    .await?;
            }
            JobResultState::Paused => {
                if current.state != JobState::Pausing {
                    bail!("worker returned PAUSED for job that was not pausing");
                }
                self.jobs.transition(current.id, JobState::Paused).await?;
            }
            JobResultState::Failed => {
                let code = result
                    .error
                    .as_ref()
                    .and_then(|value| value.get("code"))
                    .and_then(Value::as_str)
                    .unwrap_or("WORKER_ERROR");
                if matches!(code, "CANCELLED" | "JOB_CANCELLED") {
                    self.jobs
                        .transition(current.id, JobState::Cancelled)
                        .await?;
                } else {
                    self.jobs
                        .fail(current.id, code, result.error.clone())
                        .await?;
                }
            }
        }

        self.release_worker(worker_id).await;
        Ok(())
    }

    async fn apply_observation_analysis(&self, job: &Job, result: &JobResult) -> Result<()> {
        let output = result
            .outputs
            .iter()
            .find(|output| {
                output.get("kind").and_then(Value::as_str) == Some("observation-analysis")
            })
            .context("analysis result is missing observation-analysis output")?;

        let observation_id = parse_uuid_field(output, "observation_id")?;
        let expected_observation_id = parse_uuid_field(&job.input, "observation_id")?;
        if observation_id != expected_observation_id {
            bail!("analysis output observation_id does not match job input");
        }
        let artifact_id = parse_uuid_field(output, "artifact_id")?;
        let expected_artifact_id = parse_uuid_field(&job.input, "artifact_id")?;
        if artifact_id != expected_artifact_id {
            bail!("analysis output artifact_id does not match job input");
        }

        let preview_token = output
            .get("preview_token")
            .and_then(Value::as_str)
            .context("analysis result is missing preview_token")?;
        let preview = self
            .artifacts
            .import_worker_output(
                preview_token,
                "image/jpeg",
                ArtifactLogicalType::Preview,
                json!({
                    "kind": "OBSERVATION_PREVIEW",
                    "source_job_id": job.id,
                    "observation_id": observation_id,
                    "source_artifact_id": artifact_id,
                }),
            )
            .await?;

        let timestamp = output
            .get("timestamp")
            .and_then(Value::as_str)
            .map(DateTime::parse_from_rfc3339)
            .transpose()?
            .map(|value| value.with_timezone(&Utc));
        let camera_intrinsics = output
            .get("camera_intrinsics")
            .filter(|value| !value.is_null())
            .cloned();
        let observation = self
            .observations
            .get(observation_id)
            .await?
            .context("analysis observation does not exist")?;
        if observation.artifact_id != Some(artifact_id) {
            bail!("analysis observation artifact does not match job input");
        }

        let worker_quality = output
            .get("quality")
            .and_then(Value::as_object)
            .context("analysis result quality must be an object")?;
        let mut quality = observation.quality;
        let quality_object = quality
            .as_object_mut()
            .context("stored observation quality must be an object")?;
        for (key, value) in worker_quality {
            quality_object.insert(key.clone(), value.clone());
        }
        quality_object.insert(
            "analysis_state".to_owned(),
            Value::String("COMPLETED".to_owned()),
        );
        quality_object.insert(
            "preview_artifact_id".to_owned(),
            Value::String(preview.id.to_string()),
        );

        self.observations
            .apply_image_analysis(observation_id, timestamp, camera_intrinsics, quality)
            .await?;
        Ok(())
    }

    async fn release_worker(&self, worker_id: Uuid) {
        if let Some(handle) = self.workers.read().await.get(&worker_id).cloned() {
            handle.busy.store(false, Ordering::SeqCst);
        }
    }
}

fn source_id(source_worker_id: &StdMutex<Option<Uuid>>) -> Result<Uuid> {
    source_worker_id
        .lock()
        .map_err(|_| anyhow::anyhow!("worker identity lock poisoned"))?
        .as_ref()
        .copied()
        .context("worker sent message before REGISTER")
}

fn ensure_source_worker(source_worker_id: &StdMutex<Option<Uuid>>, worker_id: Uuid) -> Result<()> {
    let source = source_id(source_worker_id)?;
    if source != worker_id {
        bail!("worker payload identity does not match registered process");
    }
    Ok(())
}

fn parse_uuid_field(value: &Value, key: &str) -> Result<Uuid> {
    let raw = value
        .get(key)
        .and_then(Value::as_str)
        .with_context(|| format!("{key} must be a UUID string"))?;
    Uuid::parse_str(raw).with_context(|| format!("{key} is not a valid UUID"))
}


#[cfg(test)]
mod tests {
    use std::{path::PathBuf, time::Duration};

    use tempfile::tempdir;
    use tokio::time;
    use crate::{
        artifact_store::ArtifactStore,
        db,
        job_engine::JobEngine,
        model::JobState,
        worker_runtime::{WorkerRuntime, WorkerSpec},
    };

    #[tokio::test]
    async fn runtime_executes_ready_job_through_real_worker_process() {
        let pool = db::connect_memory().await.unwrap();
        let artifact_root = tempdir().unwrap();
        let artifacts = ArtifactStore::new(artifact_root.path(), pool.clone())
            .await
            .unwrap();

        let repo_root = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .unwrap()
            .to_path_buf();
        let python = if cfg!(windows) { "python" } else { "python3" };
        let runtime = WorkerRuntime::start(
            pool.clone(),
            artifacts,
            vec![WorkerSpec::python_module(
                "tools-test",
                python,
                "workers.tools.main",
                repo_root,
                artifact_root.path(),
            )],
        )
        .await
        .unwrap();

        let event_pool = pool.clone();
        let jobs = JobEngine::new(pool);
        let job = jobs
            .create(None, "DISCOVER_TOOLS", 1, true)
            .await
            .unwrap();
        jobs.transition(job.id, JobState::Ready).await.unwrap();

        let completed = time::timeout(Duration::from_secs(10), async {
            loop {
                let current = jobs.get(job.id).await.unwrap().unwrap();
                if current.state == JobState::Completed {
                    break current;
                }
                if current.state == JobState::Failed {
                    panic!("runtime worker job failed: {:?}", current.error_payload);
                }
                time::sleep(Duration::from_millis(50)).await;
            }
        })
        .await
        .expect("runtime worker job timed out");

        assert_eq!(completed.state, JobState::Completed);
        assert_eq!(completed.attempt, 1);
        assert!(completed.assigned_worker_id.is_none());

        let result_events: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM job_events WHERE job_id = ? AND event_type = 'JOB_RESULT'",
        )
        .bind(job.id.to_string())
        .fetch_one(&event_pool)
        .await
        .unwrap();
        assert_eq!(result_events, 1);

        runtime.shutdown().await;
    }
}
