use anyhow::{bail, Result};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

pub const HUNYUAN_3D_ENDPOINT: &str = "fal-ai/hunyuan3d-v3/image-to-3d";
pub const HUNYUAN_PROVIDER: &str = "hunyuan";
pub const MIN_FACE_COUNT: u32 = 40_000;
pub const MAX_FACE_COUNT: u32 = 1_500_000;

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
pub enum HunyuanGenerateType {
    Normal,
    LowPoly,
    Geometry,
}

impl HunyuanGenerateType {
    fn as_api_str(self) -> &'static str {
        match self {
            Self::Normal => "Normal",
            Self::LowPoly => "LowPoly",
            Self::Geometry => "Geometry",
        }
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
pub enum HunyuanPolygonType {
    Triangle,
    Quadrilateral,
}

impl HunyuanPolygonType {
    fn as_api_str(self) -> &'static str {
        match self {
            Self::Triangle => "triangle",
            Self::Quadrilateral => "quadrilateral",
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Hunyuan3dOptions {
    pub face_count: u32,
    pub enable_pbr: bool,
    pub generate_type: HunyuanGenerateType,
    pub polygon_type: HunyuanPolygonType,
}

impl Default for Hunyuan3dOptions {
    fn default() -> Self {
        Self {
            face_count: 50_000,
            enable_pbr: true,
            generate_type: HunyuanGenerateType::Normal,
            polygon_type: HunyuanPolygonType::Triangle,
        }
    }
}

impl Hunyuan3dOptions {
    pub fn validate(&self) -> Result<()> {
        if !(MIN_FACE_COUNT..=MAX_FACE_COUNT).contains(&self.face_count) {
            bail!("face_count must be between {MIN_FACE_COUNT} and {MAX_FACE_COUNT}");
        }
        Ok(())
    }

    pub fn build_input(&self, image_url: &str) -> Result<Value> {
        self.validate()?;
        let mut input = json!({
            "input_image_url": image_url,
            "generate_type": self.generate_type.as_api_str(),
            "enable_pbr": self.enable_pbr,
            "face_count": self.face_count
        });
        if self.generate_type == HunyuanGenerateType::LowPoly {
            input["polygon_type"] = Value::String(self.polygon_type.as_api_str().to_owned());
        }
        Ok(input)
    }
}

#[cfg(test)]
mod tests {
    use super::{Hunyuan3dOptions, HunyuanGenerateType, MIN_FACE_COUNT};

    #[test]
    fn preserves_upstream_defaults_and_lowpoly_polygon_behavior() {
        let defaults = Hunyuan3dOptions::default();
        let input = defaults
            .build_input("https://example.com/input.png")
            .unwrap();
        assert_eq!(input["face_count"], 50_000);
        assert!(input.get("polygon_type").is_none());

        let lowpoly = Hunyuan3dOptions {
            generate_type: HunyuanGenerateType::LowPoly,
            ..Default::default()
        };
        let input = lowpoly
            .build_input("https://example.com/input.png")
            .unwrap();
        assert_eq!(input["polygon_type"], "triangle");
    }

    #[test]
    fn rejects_face_counts_outside_provider_contract() {
        let options = Hunyuan3dOptions {
            face_count: MIN_FACE_COUNT - 1,
            ..Default::default()
        };
        assert!(options.validate().is_err());
    }
}
