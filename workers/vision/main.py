from __future__ import annotations

import os
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from PIL import ExifTags, Image, ImageFilter, ImageStat

from workers.sdk.runtime import JobContext, WorkerApp


def _artifact_path(token: str) -> Path:
    root_raw = os.environ.get("WORLD888_ARTIFACT_ROOT")
    if not root_raw:
        raise RuntimeError("WORLD888_ARTIFACT_ROOT is not configured")
    root = Path(root_raw).resolve()
    path = (root / token).resolve()
    if root != path and root not in path.parents:
        raise ValueError("artifact token escaped artifact root")
    if not path.is_file():
        raise FileNotFoundError(f"artifact does not exist: {token}")
    return path


def _ratio_to_float(value: Any) -> float | None:
    try:
        return float(value)
    except (TypeError, ValueError, ZeroDivisionError):
        return None


def _read_exif(image: Image.Image) -> tuple[dict[str, Any], str | None, dict[str, Any] | None]:
    exif = image.getexif()
    if not exif:
        return {}, None, None

    tags: dict[str, Any] = {}
    for key, value in exif.items():
        name = ExifTags.TAGS.get(key, str(key))
        if isinstance(value, bytes):
            continue
        if isinstance(value, (str, int, float)):
            tags[name] = value
        else:
            rendered = str(value)
            if len(rendered) <= 256:
                tags[name] = rendered

    timestamp = None
    raw_time = tags.get("DateTimeOriginal") or tags.get("DateTime")
    if isinstance(raw_time, str):
        try:
            parsed = datetime.strptime(raw_time, "%Y:%m:%d %H:%M:%S").replace(tzinfo=UTC)
            timestamp = parsed.isoformat()
        except ValueError:
            tags["capture_time_raw"] = raw_time

    focal = _ratio_to_float(exif.get(37386))
    intrinsics = None
    if focal is not None:
        intrinsics = {
            "focal_length_mm": focal,
            "orientation": exif.get(274),
            "source": "EXIF",
        }
    return tags, timestamp, intrinsics


def _quality(image: Image.Image) -> dict[str, Any]:
    width, height = image.size
    sample = image.convert("L")
    sample.thumbnail((512, 512))

    stats = ImageStat.Stat(sample)
    mean_luma = float(stats.mean[0]) / 255.0
    contrast = float(stats.stddev[0]) / 255.0
    edges = sample.filter(ImageFilter.FIND_EDGES)
    edge_score = min(1.0, float(ImageStat.Stat(edges).mean[0]) / 32.0)

    exposure = "OK"
    if mean_luma < 0.12:
        exposure = "UNDEREXPOSED"
    elif mean_luma > 0.88:
        exposure = "OVEREXPOSED"

    minimum_dimension = min(width, height)
    usable_for_geometry = (
        minimum_dimension >= 720
        and edge_score >= 0.12
        and exposure == "OK"
    )
    usable_for_texture = minimum_dimension >= 720 and exposure == "OK"

    return {
        "width": width,
        "height": height,
        "megapixels": round((width * height) / 1_000_000, 3),
        "mean_luma": round(mean_luma, 4),
        "contrast": round(contrast, 4),
        "sharpness_score": round(edge_score, 4),
        "exposure": exposure,
        "usable_for_geometry": usable_for_geometry,
        "usable_for_texture": usable_for_texture,
    }


def analyze_observation(context: JobContext, payload: dict[str, Any]) -> dict[str, Any]:
    parameters = payload.get("parameters")
    if not isinstance(parameters, dict):
        raise ValueError("ANALYZE_OBSERVATION parameters are required")

    observation_id = parameters.get("observation_id")
    artifact_id = parameters.get("artifact_id")
    artifact_token = parameters.get("artifact_token")
    if not all(isinstance(value, str) and value for value in (observation_id, artifact_id, artifact_token)):
        raise ValueError("observation_id, artifact_id and artifact_token are required")

    path = _artifact_path(artifact_token)
    context.emit_progress(0.1, "OBSERVATION_OPENED")

    with Image.open(path) as image:
        image.load()
        exif, timestamp, camera_intrinsics = _read_exif(image)
        quality = _quality(image)
        quality["exif"] = exif
        context.emit_progress(0.55, "OBSERVATION_ANALYZED", {
            "width": image.width,
            "height": image.height,
        })

        preview = image.convert("RGB")
        preview.thumbnail((1024, 1024))
        root = Path(os.environ["WORLD888_ARTIFACT_ROOT"]).resolve()
        output_dir = root / ".worker-output" / str(context.job_id)
        output_dir.mkdir(parents=True, exist_ok=True)
        preview_path = output_dir / "preview.jpg"
        preview.save(preview_path, "JPEG", quality=85, optimize=True)
        preview_token = preview_path.relative_to(root).as_posix()

    context.emit_progress(0.9, "OBSERVATION_PREVIEW_READY")
    return {
        "kind": "observation-analysis",
        "observation_id": observation_id,
        "artifact_id": artifact_id,
        "timestamp": timestamp,
        "camera_intrinsics": camera_intrinsics,
        "quality": quality,
        "preview_token": preview_token,
    }


def healthcheck(context: JobContext, payload: dict[str, Any]) -> dict[str, Any]:
    context.emit_progress(0.5, "VISION_RUNTIME_READY")
    return {
        "kind": "vision-runtime",
        "status": "ok",
        "requested_parameters": payload.get("parameters", {}),
    }


def build_app() -> WorkerApp:
    return WorkerApp(
        worker_type="VISION",
        capabilities=["HEALTHCHECK", "ANALYZE_OBSERVATION"],
        handlers={
            "HEALTHCHECK": healthcheck,
            "ANALYZE_OBSERVATION": analyze_observation,
        },
    )


def main() -> int:
    return build_app().run()


if __name__ == "__main__":
    raise SystemExit(main())
