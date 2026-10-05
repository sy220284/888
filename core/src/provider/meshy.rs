use anyhow::{bail, Result};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

pub const MESHY_3D_ENDPOINT: &str = "fal-ai/meshy/v6/image-to-3d";
pub const MESHY_PROVIDER: &str = "meshy";

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Meshy3dOptions {
    pub topology: String,
    pub target_polycount: u32,
    pub symmetry_mode: String,
    pub should_remesh: bool,
    pub should_texture: bool,
    pub rigging_height_meters: f64,
    pub animation_action_id: i32,
    pub enable_safety_checker: bool,
    pub enable_animation: bool,
    pub enable_rigging: bool,
    pub enable_pbr: bool,
}

impl Default for Meshy3dOptions {
    fn default() -> Self {
        Self {
            topology: "triangle".to_owned(),
            target_polycount: 30_000,
            symmetry_mode: "auto".to_owned(),
            should_remesh: true,
            should_texture: true,
            rigging_height_meters: 1.7,
            animation_action_id: 12,
            enable_safety_checker: true,
            enable_animation: false,
            enable_rigging: false,
            enable_pbr: true,
        }
    }
}

impl Meshy3dOptions {
    pub fn validate(&self) -> Result<()> {
        if self.topology.trim().is_empty() {
            bail!("topology must not be empty");
        }
        if self.target_polycount == 0 {
            bail!("target_polycount must be greater than 0");
        }
        if self.symmetry_mode.trim().is_empty() {
            bail!("symmetry_mode must not be empty");
        }
        if !self.rigging_height_meters.is_finite() {
            bail!("rigging_height_meters must be finite");
        }
        Ok(())
    }

    pub fn build_input(&self, image_url: &str) -> Result<Value> {
        self.validate()?;
        Ok(json!({
            "image_url": image_url,
            "topology": &self.topology,
            "target_polycount": self.target_polycount,
            "symmetry_mode": &self.symmetry_mode,
            "should_remesh": self.should_remesh,
            "should_texture": self.should_texture,
            "rigging_height_meters": self.rigging_height_meters,
            "animation_action_id": self.animation_action_id,
            "enable_safety_checker": self.enable_safety_checker,
            "enable_animation": self.enable_animation,
            "enable_rigging": self.enable_rigging,
            "enable_pbr": self.enable_pbr
        }))
    }
}

#[cfg(test)]
mod tests {
    use super::Meshy3dOptions;

    #[test]
    fn preserves_upstream_meshy_defaults() {
        let input = Meshy3dOptions::default()
            .build_input("https://example.com/input.png")
            .unwrap();
        assert_eq!(input["target_polycount"], 30_000);
        assert_eq!(input["enable_pbr"], true);
        assert_eq!(input["enable_animation"], false);
    }

    #[test]
    fn rejects_invalid_polycount() {
        let options = Meshy3dOptions {
            target_polycount: 0,
            ..Default::default()
        };
        assert!(options.validate().is_err());
    }
}
