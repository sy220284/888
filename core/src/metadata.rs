use serde_json::Value;

/// Removes embedded binary payloads before provider input/output is persisted.
/// Provider metadata must remain inspectable without duplicating base64 assets in SQLite.
pub fn sanitize_json(value: &Value) -> Value {
    sanitize_json_with_key(value, "")
}

fn sanitize_json_with_key(value: &Value, key: &str) -> Value {
    match value {
        Value::String(text) => {
            if is_data_uri(text) || is_base64_key(key) {
                Value::String("[stripped]".to_owned())
            } else {
                Value::String(text.clone())
            }
        }
        Value::Array(values) => Value::Array(
            values
                .iter()
                .map(|value| sanitize_json_with_key(value, key))
                .collect(),
        ),
        Value::Object(map) => Value::Object(
            map.iter()
                .map(|(child_key, child)| {
                    (
                        child_key.clone(),
                        sanitize_json_with_key(child, child_key),
                    )
                })
                .collect(),
        ),
        _ => value.clone(),
    }
}

fn is_base64_key(key: &str) -> bool {
    let lower = key.to_ascii_lowercase();
    lower.contains("base64") || lower.contains("b64")
}

fn is_data_uri(value: &str) -> bool {
    value.len() >= 5 && value[..5].eq_ignore_ascii_case("data:")
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::sanitize_json;

    #[test]
    fn strips_data_uris_and_base64_fields_recursively() {
        let input = json!({
            "image": "data:image/png;base64,AAAA",
            "nested": {
                "preview_b64": "AAAA",
                "safe": "https://example.com/file.glb"
            },
            "items": [{"base64_data": "BBBB"}]
        });

        assert_eq!(
            sanitize_json(&input),
            json!({
                "image": "[stripped]",
                "nested": {
                    "preview_b64": "[stripped]",
                    "safe": "https://example.com/file.glb"
                },
                "items": [{"base64_data": "[stripped]"}]
            })
        );
    }
}
