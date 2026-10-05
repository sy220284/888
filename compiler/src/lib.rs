use anyhow::{bail, Context, Result};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use uuid::Uuid;

const SUPPORTED_TARGETS: &[&str] = &["GLB", "BLENDER", "UNITY", "GODOT", "UNREAL", "WEB", "XR"];
const SUPPORTED_QUALITY: &[&str] = &["FAST", "BALANCED", "HIGH", "MAX"];

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct CompileRequest {
    pub world_id: Uuid,
    pub revision_id: Uuid,
    pub target: String,
    pub quality_profile: String,
    pub canonical_world: Value,
    pub options: Value,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct CompileStage {
    pub name: String,
    pub required: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct CompilePlan {
    pub world_id: Uuid,
    pub revision_id: Uuid,
    pub target: String,
    pub quality_profile: String,
    pub stages: Vec<CompileStage>,
}

pub fn plan(request: &CompileRequest) -> Result<CompilePlan> {
    if !SUPPORTED_TARGETS.contains(&request.target.as_str()) {
        bail!("unsupported compiler target: {}", request.target);
    }
    if !SUPPORTED_QUALITY.contains(&request.quality_profile.as_str()) {
        bail!(
            "unsupported compiler quality profile: {}",
            request.quality_profile
        );
    }

    let world_id = request
        .canonical_world
        .get("id")
        .and_then(Value::as_str)
        .context("canonical world snapshot must contain id")?;
    let snapshot_world_id = Uuid::parse_str(world_id).context("invalid canonical world id")?;
    if snapshot_world_id != request.world_id {
        bail!("canonical world snapshot does not match compile world_id");
    }

    Ok(CompilePlan {
        world_id: request.world_id,
        revision_id: request.revision_id,
        target: request.target.clone(),
        quality_profile: request.quality_profile.clone(),
        stages: vec![
            CompileStage {
                name: "validate-canonical-world".to_owned(),
                required: true,
            },
            CompileStage {
                name: "resolve-representations".to_owned(),
                required: true,
            },
            CompileStage {
                name: "compile-target-assets".to_owned(),
                required: true,
            },
            CompileStage {
                name: "write-export-manifest".to_owned(),
                required: true,
            },
        ],
    })
}

#[cfg(test)]
mod tests {
    use serde_json::json;
    use uuid::Uuid;

    use super::{plan, CompileRequest};

    #[test]
    fn planning_is_read_only_and_target_scoped() {
        let world_id = Uuid::new_v4();
        let snapshot = json!({"id": world_id, "entities": []});
        let before = snapshot.clone();
        let request = CompileRequest {
            world_id,
            revision_id: Uuid::new_v4(),
            target: "GLB".into(),
            quality_profile: "BALANCED".into(),
            canonical_world: snapshot,
            options: json!({}),
        };

        let result = plan(&request).unwrap();
        assert_eq!(result.target, "GLB");
        assert_eq!(request.canonical_world, before);
    }

    #[test]
    fn rejects_unknown_target() {
        let world_id = Uuid::new_v4();
        let request = CompileRequest {
            world_id,
            revision_id: Uuid::new_v4(),
            target: "UNKNOWN".into(),
            quality_profile: "BALANCED".into(),
            canonical_world: json!({"id": world_id}),
            options: json!({}),
        };
        assert!(plan(&request).is_err());
    }
}
