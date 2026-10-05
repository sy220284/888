use anyhow::{bail, Context, Result};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::{
    artifact_store::ArtifactStore,
    model::{AIOutputEnvelope, Artifact},
    provider::{
        hunyuan::Hunyuan3dOptions,
        image_edit::{FalImageEditRunner, ImageEditOptions},
        image_to_3d::FalImageTo3dRunner,
        meshy::Meshy3dOptions,
    },
};

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
pub enum Object3dProvider {
    Hunyuan,
    Meshy,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AssetGenerationOptions {
    pub image_edit: ImageEditOptions,
    pub object_3d_provider: Object3dProvider,
    pub hunyuan: Hunyuan3dOptions,
    pub meshy: Meshy3dOptions,
    pub reference_only: bool,
}

impl Default for AssetGenerationOptions {
    fn default() -> Self {
        Self {
            image_edit: ImageEditOptions::default(),
            object_3d_provider: Object3dProvider::Hunyuan,
            hunyuan: Hunyuan3dOptions::default(),
            meshy: Meshy3dOptions::default(),
            reference_only: false,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AssetGenerationResult {
    pub reference_image_artifact_id: Uuid,
    pub image_edit_run: AIOutputEnvelope,
    pub model_run: Option<AIOutputEnvelope>,
}

#[derive(Clone)]
pub struct AssetGenerationService {
    artifacts: ArtifactStore,
    image_edit: FalImageEditRunner,
    image_to_3d: FalImageTo3dRunner,
}

impl AssetGenerationService {
    pub fn new(
        artifacts: ArtifactStore,
        image_edit: FalImageEditRunner,
        image_to_3d: FalImageTo3dRunner,
    ) -> Self {
        Self {
            artifacts,
            image_edit,
            image_to_3d,
        }
    }

    pub async fn run(
        &self,
        source_images: &[Artifact],
        mask: Option<&Artifact>,
        options: &AssetGenerationOptions,
    ) -> Result<AssetGenerationResult> {
        if source_images.is_empty() {
            bail!("asset generation requires at least one source image artifact");
        }

        let image_edit_run = self
            .image_edit
            .run(source_images, mask, &options.image_edit)
            .await?;
        let reference_image = self
            .first_image_artifact(&image_edit_run.artifact_ids)
            .await
            .context("image edit completed without an image artifact")?;

        if options.reference_only {
            return Ok(AssetGenerationResult {
                reference_image_artifact_id: reference_image.id,
                image_edit_run,
                model_run: None,
            });
        }

        let model_run = match options.object_3d_provider {
            Object3dProvider::Hunyuan => {
                self.image_to_3d
                    .run_hunyuan(&reference_image, &options.hunyuan)
                    .await?
            }
            Object3dProvider::Meshy => {
                self.image_to_3d
                    .run_meshy(&reference_image, &options.meshy)
                    .await?
            }
        };

        Ok(AssetGenerationResult {
            reference_image_artifact_id: reference_image.id,
            image_edit_run,
            model_run: Some(model_run),
        })
    }

    async fn first_image_artifact(&self, ids: &[Uuid]) -> Result<Option<Artifact>> {
        for id in ids {
            if let Some(artifact) = self.artifacts.get(*id).await? {
                if artifact.mime.starts_with("image/") {
                    return Ok(Some(artifact));
                }
            }
        }
        Ok(None)
    }
}

#[cfg(test)]
mod tests {
    use super::{AssetGenerationOptions, Object3dProvider};

    #[test]
    fn defaults_to_hunyuan_and_full_generation() {
        let options = AssetGenerationOptions::default();
        assert_eq!(options.object_3d_provider, Object3dProvider::Hunyuan);
        assert!(!options.reference_only);
    }
}
