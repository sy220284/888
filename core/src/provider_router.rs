use std::cmp::Ordering;

use anyhow::{Context, Result};
use serde_json::json;

use crate::{
    model::{
        CanonicalCapabilityRequest, CanonicalCapabilityRequestCapability,
        CanonicalCapabilityRequestQualityProfile, ProviderCapability, ProviderCapabilityCapability,
        ProviderCapabilityHealth, ProviderCapabilityLocation,
        ProviderCapabilityQualityProfilesItem,
    },
    provider::{
        hunyuan::{HUNYUAN_3D_ENDPOINT, HUNYUAN_PROVIDER},
        image_edit::{GPT_IMAGE_2_ENDPOINT, NANO_BANANA_ENDPOINT},
        meshy::{MESHY_3D_ENDPOINT, MESHY_PROVIDER},
        sfx::{ELEVENLABS_SFX_ENDPOINT, ELEVENLABS_SFX_PROVIDER},
        world_labs::{WORLD_LABS_MODEL, WORLD_LABS_PROVIDER},
    },
    serde_db::enum_to_string,
};

#[derive(Clone, Default)]
pub struct ProviderRouter {
    providers: Vec<ProviderCapability>,
}

impl ProviderRouter {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn with_builtins() -> Self {
        Self {
            providers: builtin_provider_capabilities(),
        }
    }

    pub fn upsert(&mut self, provider: ProviderCapability) {
        if let Some(existing) = self.providers.iter_mut().find(|existing| {
            existing.provider_id == provider.provider_id
                && existing.capability == provider.capability
        }) {
            *existing = provider;
        } else {
            self.providers.push(provider);
        }
    }

    pub fn set_health(
        &mut self,
        provider_id: &str,
        capability: ProviderCapabilityCapability,
        health: ProviderCapabilityHealth,
    ) -> Result<()> {
        let provider = self
            .providers
            .iter_mut()
            .find(|provider| {
                provider.provider_id == provider_id && provider.capability == capability
            })
            .context("provider capability is not registered")?;
        provider.health = health;
        Ok(())
    }

    pub fn select(&self, request: &CanonicalCapabilityRequest) -> Result<ProviderCapability> {
        let requested_capability = enum_to_string(&request.capability)?;
        let requested_quality = enum_to_string(&request.quality_profile)?;
        let mut candidates: Vec<&ProviderCapability> =
            self.providers
                .iter()
                .filter(|provider| {
                    enum_to_string(&provider.capability)
                        .is_ok_and(|capability| capability == requested_capability)
                })
                .filter(|provider| {
                    matches!(
                        provider.health,
                        ProviderCapabilityHealth::Healthy | ProviderCapabilityHealth::Degraded
                    )
                })
                .filter(|provider| {
                    provider.quality_profiles.iter().any(|profile| {
                        enum_to_string(profile).is_ok_and(|value| value == requested_quality)
                    })
                })
                .filter(|provider| {
                    request.cost_budget.is_none_or(|budget| {
                        provider.estimated_cost.is_some_and(|cost| cost <= budget)
                    })
                })
                .filter(|provider| {
                    request.latency_budget_ms.is_none_or(|budget| {
                        provider
                            .average_latency_ms
                            .is_some_and(|latency| latency <= budget)
                    })
                })
                .collect();

        candidates.sort_by(|left, right| compare_provider(left, right));
        candidates
            .first()
            .cloned()
            .cloned()
            .context("no provider satisfies the canonical capability request")
    }

    pub fn providers(&self) -> &[ProviderCapability] {
        &self.providers
    }
}

fn compare_provider(left: &ProviderCapability, right: &ProviderCapability) -> Ordering {
    health_rank(left.health)
        .cmp(&health_rank(right.health))
        .then_with(|| compare_optional_f64(left.estimated_cost, right.estimated_cost))
        .then_with(|| left.average_latency_ms.cmp(&right.average_latency_ms))
        .then_with(|| left.provider_id.cmp(&right.provider_id))
}

fn health_rank(health: ProviderCapabilityHealth) -> u8 {
    match health {
        ProviderCapabilityHealth::Healthy => 0,
        ProviderCapabilityHealth::Degraded => 1,
        ProviderCapabilityHealth::RateLimited => 2,
        ProviderCapabilityHealth::AuthError => 3,
        ProviderCapabilityHealth::Unavailable => 4,
    }
}

fn compare_optional_f64(left: Option<f64>, right: Option<f64>) -> Ordering {
    match (left, right) {
        (Some(left), Some(right)) => left.total_cmp(&right),
        (Some(_), None) => Ordering::Less,
        (None, Some(_)) => Ordering::Greater,
        (None, None) => Ordering::Equal,
    }
}

pub fn builtin_provider_capabilities() -> Vec<ProviderCapability> {
    let quality = || {
        vec![
            ProviderCapabilityQualityProfilesItem::Balanced,
            ProviderCapabilityQualityProfilesItem::High,
        ]
    };
    let remote = ProviderCapabilityLocation::Remote;
    let unverified_health = ProviderCapabilityHealth::Degraded;

    vec![
        ProviderCapability {
            provider_id: HUNYUAN_PROVIDER.to_owned(),
            capability: ProviderCapabilityCapability::Object3d,
            location: remote,
            health: unverified_health,
            model_id: Some(HUNYUAN_3D_ENDPOINT.to_owned()),
            model_version: Some("v3".to_owned()),
            quality_profiles: quality(),
            input_types: vec!["image".to_owned()],
            output_types: vec!["mesh".to_owned()],
            estimated_cost: None,
            average_latency_ms: None,
            metadata: Some(json!({"transport": "fal-queue"})),
        },
        ProviderCapability {
            provider_id: MESHY_PROVIDER.to_owned(),
            capability: ProviderCapabilityCapability::Object3d,
            location: remote,
            health: unverified_health,
            model_id: Some(MESHY_3D_ENDPOINT.to_owned()),
            model_version: Some("v6".to_owned()),
            quality_profiles: quality(),
            input_types: vec!["image".to_owned()],
            output_types: vec!["mesh".to_owned()],
            estimated_cost: None,
            average_latency_ms: None,
            metadata: Some(json!({"transport": "fal-queue"})),
        },
        ProviderCapability {
            provider_id: WORLD_LABS_PROVIDER.to_owned(),
            capability: ProviderCapabilityCapability::WorldCompletion,
            location: remote,
            health: unverified_health,
            model_id: Some(WORLD_LABS_MODEL.to_owned()),
            model_version: Some(WORLD_LABS_MODEL.to_owned()),
            quality_profiles: quality(),
            input_types: vec!["image".to_owned(), "text".to_owned()],
            output_types: vec!["splat".to_owned(), "collider".to_owned(), "pano".to_owned()],
            estimated_cost: None,
            average_latency_ms: None,
            metadata: Some(json!({"transport": "world-labs-operation"})),
        },
        ProviderCapability {
            provider_id: "gpt-image-2".to_owned(),
            capability: ProviderCapabilityCapability::ImageEdit,
            location: remote,
            health: unverified_health,
            model_id: Some(GPT_IMAGE_2_ENDPOINT.to_owned()),
            model_version: None,
            quality_profiles: quality(),
            input_types: vec!["image".to_owned(), "text".to_owned()],
            output_types: vec!["image".to_owned()],
            estimated_cost: None,
            average_latency_ms: None,
            metadata: Some(json!({"transport": "fal-queue"})),
        },
        ProviderCapability {
            provider_id: "nano-banana".to_owned(),
            capability: ProviderCapabilityCapability::ImageEdit,
            location: remote,
            health: unverified_health,
            model_id: Some(NANO_BANANA_ENDPOINT.to_owned()),
            model_version: None,
            quality_profiles: quality(),
            input_types: vec!["image".to_owned(), "text".to_owned()],
            output_types: vec!["image".to_owned()],
            estimated_cost: None,
            average_latency_ms: None,
            metadata: Some(json!({"transport": "fal-queue"})),
        },
        ProviderCapability {
            provider_id: ELEVENLABS_SFX_PROVIDER.to_owned(),
            capability: ProviderCapabilityCapability::Audio,
            location: remote,
            health: unverified_health,
            model_id: Some(ELEVENLABS_SFX_ENDPOINT.to_owned()),
            model_version: Some("v2".to_owned()),
            quality_profiles: quality(),
            input_types: vec!["text".to_owned()],
            output_types: vec!["audio".to_owned()],
            estimated_cost: None,
            average_latency_ms: None,
            metadata: Some(json!({"transport": "fal-queue"})),
        },
    ]
}

#[cfg(test)]
mod tests {
    use serde_json::json;
    use uuid::Uuid;

    use crate::model::{
        CanonicalCapabilityRequest, CanonicalCapabilityRequestCapability,
        CanonicalCapabilityRequestCreativityProfile, CanonicalCapabilityRequestQualityProfile,
        ProviderCapabilityHealth,
    };

    use super::ProviderRouter;

    fn request(capability: CanonicalCapabilityRequestCapability) -> CanonicalCapabilityRequest {
        CanonicalCapabilityRequest {
            request_id: Uuid::new_v4(),
            capability,
            input_artifact_ids: vec![],
            world_context_ref: None,
            parameters: json!({}),
            evidence_policy: json!({}),
            constraints: json!({}),
            output_schema: json!({}),
            quality_profile: CanonicalCapabilityRequestQualityProfile::Balanced,
            creativity_profile: CanonicalCapabilityRequestCreativityProfile::Strict,
            cost_budget: None,
            latency_budget_ms: None,
            verification_required: true,
            deterministic_seed: None,
            provider_hints: None,
        }
    }

    #[test]
    fn routes_by_canonical_capability_without_brand_logic_in_business_request() {
        let mut router = ProviderRouter::with_builtins();
        router
            .set_health(
                "hunyuan",
                crate::model::ProviderCapabilityCapability::Object3d,
                ProviderCapabilityHealth::Healthy,
            )
            .unwrap();

        let selected = router
            .select(&request(CanonicalCapabilityRequestCapability::Object3d))
            .unwrap();
        assert_eq!(selected.provider_id, "hunyuan");
    }

    #[test]
    fn budgeted_request_rejects_provider_without_estimate() {
        let mut router = ProviderRouter::with_builtins();
        router
            .set_health(
                "hunyuan",
                crate::model::ProviderCapabilityCapability::Object3d,
                ProviderCapabilityHealth::Healthy,
            )
            .unwrap();
        let mut request = request(CanonicalCapabilityRequestCapability::Object3d);
        request.cost_budget = Some(1.0);
        assert!(router.select(&request).is_err());
    }

    #[test]
    fn refuses_unregistered_or_unhealthy_capability() {
        let router = ProviderRouter::new();
        assert!(router
            .select(&request(CanonicalCapabilityRequestCapability::Object3d))
            .is_err());
    }
}
