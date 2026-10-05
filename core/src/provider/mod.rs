pub mod audio;
pub mod fal;
pub mod hunyuan;
pub mod image_edit;
pub mod image_to_3d;
pub mod meshy;
pub mod sfx;
pub mod world_labs;

use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct RemoteFileRef {
    pub label: String,
    pub url: String,
    pub file_name: Option<String>,
    pub content_type: Option<String>,
}

pub fn collect_remote_files(value: &Value) -> Vec<RemoteFileRef> {
    let mut output = Vec::new();
    let mut seen = std::collections::HashSet::new();
    collect_remote_files_inner(value, "file", &mut output, &mut seen);
    output
}

fn collect_remote_files_inner(
    value: &Value,
    label: &str,
    output: &mut Vec<RemoteFileRef>,
    seen: &mut std::collections::HashSet<String>,
) {
    match value {
        Value::Array(items) => {
            for (index, item) in items.iter().enumerate() {
                collect_remote_files_inner(item, &format!("{label}-{}", index + 1), output, seen);
            }
        }
        Value::Object(map) => {
            if let Some(url) = map.get("url").and_then(Value::as_str) {
                if seen.insert(url.to_owned()) {
                    output.push(RemoteFileRef {
                        label: label.to_owned(),
                        url: url.to_owned(),
                        file_name: map
                            .get("file_name")
                            .and_then(Value::as_str)
                            .map(str::to_owned),
                        content_type: map
                            .get("content_type")
                            .and_then(Value::as_str)
                            .map(str::to_owned),
                    });
                }
                return;
            }
            for (key, child) in map {
                collect_remote_files_inner(child, key, output, seen);
            }
        }
        _ => {}
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::collect_remote_files;

    #[test]
    fn recursively_collects_and_deduplicates_remote_files() {
        let files = collect_remote_files(&json!({
            "mesh": {"url": "https://cdn/model.glb", "content_type": "model/gltf-binary"},
            "preview": {"url": "https://cdn/preview.png", "file_name": "preview.png"},
            "duplicate": {"url": "https://cdn/model.glb"}
        }));

        assert_eq!(files.len(), 2);
        assert_eq!(
            files
                .iter()
                .filter(|file| file.url == "https://cdn/model.glb")
                .count(),
            1
        );
        assert!(files.iter().any(|file| {
            file.url == "https://cdn/preview.png"
                && file.file_name.as_deref() == Some("preview.png")
        }));
    }
}
