use std::cmp::Ordering;

use anyhow::{Context, Result};
use serde_json::json;

use crate::{
    model::{
        AIModelProfile, AIModelProfileStatus, CanonicalCapabilityRequest,
        CanonicalCapabilityRequestCapability, CanonicalCapabilityRequestCreativityProfile,
        ProviderCapability, ProviderCapabilityCapability, ProviderCapabilityHealth,
        ProviderCapabilityLocation, ProviderCapabilityQualityProfilesItem,
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
    model_profiles: Vec<AIModelProfile>,
}

impl ProviderRouter {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn with_builtins() -> Self {
        Self {
            providers: builtin_provider_capabilities(),
            model_profiles: Vec::new(),
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

    pub fn upsert_model_profile(&mut self, profile: AIModelProfile) {
        if let Some(existing) = self.model_profiles.iter_mut().find(|existing| {
            existing.provider_id == profile.provider_id
                && existing.model_id == profile.model_id
                && existing.version == profile.version
        }) {
            *existing = profile;
        } else {
            self.model_profiles.push(profile);
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
        let mut candidates: Vec<RouteCandidate<'_>> = self
            .providers
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
                request
                    .cost_budget
                    .is_none_or(|budget| provider.estimated_cost.is_some_and(|cost| cost <= budget))
            })
            .filter(|provider| {
                request.latency_budget_ms.is_none_or(|budget| {
                    provider
                        .average_latency_ms
                        .is_some_and(|latency| latency <= budget)
                })
            })
            .filter(|provider| provider_allowed_by_constraints(provider, request))
            .filter_map(|provider| {
                let profile = self.profile_for(provider);
                model_profile_allows(provider, profile, request).then(|| RouteCandidate {
                    provider,
                    profile,
                    preferred: is_preferred_provider(provider, request),
                    behavior_score: behavior_score(profile, request),
                })
            })
            .collect();

        candidates.sort_by(compare_route_candidate);
        candidates
            .first()
            .map(|candidate| candidate.provider.clone())
            .context("no provider satisfies the canonical capability request")
    }

    fn profile_for(&self, provider: &ProviderCapability) -> Option<&AIModelProfile> {
        let model_id = provider.model_id.as_deref()?;
        let exact = self.model_profiles.iter().find(|profile| {
            profile.provider_id == provider.provider_id
                && profile.model_id == model_id
                && provider
                    .model_version
                    .as_deref()
                    .is_none_or(|version| profile.version == version)
        });
        exact.or_else(|| {
            self.model_profiles.iter().find(|profile| {
                profile.provider_id == provider.provider_id && profile.model_id == model_id
            })
        })
    }

    pub fn providers(&self) -> &[ProviderCapability] {
        &self.providers
    }
}

struct RouteCandidate<'a> {
    provider: &'a ProviderCapability,
    profile: Option<&'a AIModelProfile>,
    preferred: bool,
    behavior_score: f64,
}

fn compare_route_candidate(left: &RouteCandidate<'_>, right: &RouteCandidate<'_>) -> Ordering {
    right
        .preferred
        .cmp(&left.preferred)
        .then_with(|| health_rank(left.provider.health).cmp(&health_rank(right.provider.health)))
        .then_with(|| profile_rank(left.profile).cmp(&profile_rank(right.profile)))
        .then_with(|| right.behavior_score.total_cmp(&left.behavior_score))
        .then_with(|| {
            compare_optional_f64(left.provider.estimated_cost, right.provider.estimated_cost)
        })
        .then_with(|| {
            left.provider
                .average_latency_ms
                .cmp(&right.provider.average_latency_ms)
        })
        .then_with(|| left.provider.provider_id.cmp(&right.provider.provider_id))
}

fn profile_rank(profile: Option<&AIModelProfile>) -> u8 {
    match profile.map(|profile| profile.status) {
        Some(AIModelProfileStatus::Certified) => 0,
        Some(AIModelProfileStatus::Degraded) => 1,
        None => 2,
        Some(AIModelProfileStatus::Experimental) => 3,
        Some(AIModelProfileStatus::Blocked) => 4,
    }
}

fn model_profile_allows(
    provider: &ProviderCapability,
    profile: Option<&AIModelProfile>,
    request: &CanonicalCapabilityRequest,
) -> bool {
    let requested_capability = match enum_to_string(&request.capability) {
        Ok(value) => value,
        Err(_) => return false,
    };
    let hints = request.provider_hints.as_ref();
    let allow_experimental = hint_bool(hints, "allow_experimental");
    let require_certified =
        hint_bool(hints, "require_certified") || requires_certified_profile(request.capability);

    let Some(profile) = profile else {
        return !require_certified;
    };
    if !profile.supported_capabilities.is_empty()
        && !profile
            .supported_capabilities
            .iter()
            .any(|value| value == &requested_capability)
    {
        return false;
    }

    match profile.status {
        AIModelProfileStatus::Blocked => false,
        AIModelProfileStatus::Experimental => {
            allow_experimental && is_preferred_provider(provider, request)
        }
        AIModelProfileStatus::Certified | AIModelProfileStatus::Degraded => {
            !require_certified || profile.status == AIModelProfileStatus::Certified
        }
    }
}

fn requires_certified_profile(capability: CanonicalCapabilityRequestCapability) -> bool {
    matches!(
        capability,
        CanonicalCapabilityRequestCapability::AssociativeReasoning
            | CanonicalCapabilityRequestCapability::SceneHypothesis
            | CanonicalCapabilityRequestCapability::VerificationQuestion
    )
}

fn provider_allowed_by_constraints(
    provider: &ProviderCapability,
    request: &CanonicalCapabilityRequest,
) -> bool {
    if request
        .constraints
        .get("local_only")
        .and_then(serde_json::Value::as_bool)
        .unwrap_or(false)
        && provider.location != ProviderCapabilityLocation::Local
    {
        return false;
    }

    let preferred_location = request
        .provider_hints
        .as_ref()
        .and_then(|value| value.get("required_location"))
        .and_then(serde_json::Value::as_str);
    match preferred_location {
        Some("LOCAL") => provider.location == ProviderCapabilityLocation::Local,
        Some("REMOTE") => provider.location == ProviderCapabilityLocation::Remote,
        _ => true,
    }
}

fn is_preferred_provider(
    provider: &ProviderCapability,
    request: &CanonicalCapabilityRequest,
) -> bool {
    request
        .provider_hints
        .as_ref()
        .and_then(|value| value.get("preferred_provider_ids"))
        .and_then(serde_json::Value::as_array)
        .is_some_and(|values| {
            values
                .iter()
                .filter_map(serde_json::Value::as_str)
                .any(|value| value == provider.provider_id)
        })
}

fn hint_bool(hints: Option<&serde_json::Value>, key: &str) -> bool {
    hints
        .and_then(|value| value.get(key))
        .and_then(serde_json::Value::as_bool)
        .unwrap_or(false)
}

fn behavior_score(profile: Option<&AIModelProfile>, request: &CanonicalCapabilityRequest) -> f64 {
    let Some(profile) = profile else {
        return 0.0;
    };

    let structured = metric(profile, "structured_output_reliability", 0.5);
    let instruction = metric(profile, "instruction_following", 0.5);
    let success = metric(profile, "historical_success_rate", 0.5);
    let hallucination = metric(profile, "hallucination_risk", 0.5);
    let calibration = metric(profile, "calibration_error", 0.5);
    let spatial = metric(profile, "spatial_reasoning_strength", 0.5);
    let associative = metric(profile, "associative_reasoning_strength", 0.5);
    let diversity = metric(profile, "creative_diversity", 0.5);

    let mut score = success + instruction;
    score += match request.creativity_profile {
        CanonicalCapabilityRequestCreativityProfile::Strict => {
            structured * 2.0 + (1.0 - hallucination) * 2.0 + (1.0 - calibration) * 2.0
        }
        CanonicalCapabilityRequestCreativityProfile::Balanced => {
            structured + (1.0 - hallucination) + spatial + associative
        }
        CanonicalCapabilityRequestCreativityProfile::Exploratory => {
            diversity * 2.0 + associative * 2.0 + spatial + structured * 0.5
        }
        CanonicalCapabilityRequestCreativityProfile::Divergent => {
            diversity * 3.0 + associative * 2.0 + instruction
        }
    };

    if request.verification_required {
        score += structured + (1.0 - hallucination) + (1.0 - calibration);
    }
    score
}

fn metric(profile: &AIModelProfile, key: &str, default: f64) -> f64 {
    profile
        .metrics
        .get(key)
        .and_then(serde_json::Value::as_f64)
        .filter(|value| value.is_finite())
        .map(|value| value.clamp(0.0, 1.0))
        .unwrap_or(default)
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
        AIModelProfile, AIModelProfileStatus, CanonicalCapabilityRequest,
        CanonicalCapabilityRequestCapability, CanonicalCapabilityRequestCreativityProfile,
        CanonicalCapabilityRequestQualityProfile, ProviderCapability, ProviderCapabilityCapability,
        ProviderCapabilityHealth, ProviderCapabilityLocation,
        ProviderCapabilityQualityProfilesItem,
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
    fn certified_behavior_profile_can_outweigh_provider_name_order() {
        let mut router = ProviderRouter::with_builtins();
        for provider in ["hunyuan", "meshy"] {
            router
                .set_health(
                    provider,
                    ProviderCapabilityCapability::Object3d,
                    ProviderCapabilityHealth::Healthy,
                )
                .unwrap();
        }

        router.upsert_model_profile(AIModelProfile {
            provider_id: "hunyuan".into(),
            model_id: crate::provider::hunyuan::HUNYUAN_3D_ENDPOINT.into(),
            version: "v3".into(),
            status: AIModelProfileStatus::Certified,
            supported_capabilities: vec!["OBJECT_3D".into()],
            benchmark_version: "b1".into(),
            metrics: json!({
                "structured_output_reliability": 0.5,
                "instruction_following": 0.6,
                "historical_success_rate": 0.6,
                "hallucination_risk": 0.4,
                "calibration_error": 0.3
            }),
            known_quirks: None,
            context_limit: None,
            image_limit: None,
            updated_at: None,
        });
        router.upsert_model_profile(AIModelProfile {
            provider_id: "meshy".into(),
            model_id: crate::provider::meshy::MESHY_3D_ENDPOINT.into(),
            version: "v6".into(),
            status: AIModelProfileStatus::Certified,
            supported_capabilities: vec!["OBJECT_3D".into()],
            benchmark_version: "b1".into(),
            metrics: json!({
                "structured_output_reliability": 0.95,
                "instruction_following": 0.95,
                "historical_success_rate": 0.95,
                "hallucination_risk": 0.05,
                "calibration_error": 0.05
            }),
            known_quirks: None,
            context_limit: None,
            image_limit: None,
            updated_at: None,
        });

        let selected = router
            .select(&request(CanonicalCapabilityRequestCapability::Object3d))
            .unwrap();
        assert_eq!(selected.provider_id, "meshy");
    }

    #[test]
    fn experimental_reasoning_model_requires_explicit_preference() {
        let mut router = ProviderRouter::new();
        router.upsert(ProviderCapability {
            provider_id: "experimental-reasoner".into(),
            capability: ProviderCapabilityCapability::AssociativeReasoning,
            location: ProviderCapabilityLocation::Remote,
            health: ProviderCapabilityHealth::Healthy,
            model_id: Some("reasoner-x".into()),
            model_version: Some("1".into()),
            quality_profiles: vec![ProviderCapabilityQualityProfilesItem::Balanced],
            input_types: vec!["world".into()],
            output_types: vec!["proposal".into()],
            estimated_cost: Some(0.1),
            average_latency_ms: Some(100),
            metadata: None,
        });
        router.upsert_model_profile(AIModelProfile {
            provider_id: "experimental-reasoner".into(),
            model_id: "reasoner-x".into(),
            version: "1".into(),
            status: AIModelProfileStatus::Experimental,
            supported_capabilities: vec!["ASSOCIATIVE_REASONING".into()],
            benchmark_version: "b1".into(),
            metrics: json!({"associative_reasoning_strength": 0.9}),
            known_quirks: None,
            context_limit: None,
            image_limit: None,
            updated_at: None,
        });

        let mut req = request(CanonicalCapabilityRequestCapability::AssociativeReasoning);
        req.creativity_profile = CanonicalCapabilityRequestCreativityProfile::Exploratory;
        assert!(router.select(&req).is_err());

        req.provider_hints = Some(json!({
            "allow_experimental": true,
            "preferred_provider_ids": ["experimental-reasoner"]
        }));
        let selected = router.select(&req).unwrap();
        assert_eq!(selected.provider_id, "experimental-reasoner");
    }

    #[test]
    fn local_only_constraint_rejects_remote_provider() {
        let mut router = ProviderRouter::new();
        router.upsert(ProviderCapability {
            provider_id: "remote-depth".into(),
            capability: ProviderCapabilityCapability::Depth,
            location: ProviderCapabilityLocation::Remote,
            health: ProviderCapabilityHealth::Healthy,
            model_id: None,
            model_version: None,
            quality_profiles: vec![ProviderCapabilityQualityProfilesItem::Balanced],
            input_types: vec!["image".into()],
            output_types: vec!["depth".into()],
            estimated_cost: Some(0.01),
            average_latency_ms: Some(50),
            metadata: None,
        });
        let mut req = request(CanonicalCapabilityRequestCapability::Depth);
        req.constraints = json!({"local_only": true});
        assert!(router.select(&req).is_err());
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
