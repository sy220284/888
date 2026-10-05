from __future__ import annotations

import os
import tempfile
import unittest
from pathlib import Path
from uuid import uuid4

from PIL import Image

from workers.sdk.runtime import JobContext
from workers.vision.main import analyze_observation


class VisionWorkerAnalysisTest(unittest.TestCase):
    def test_analyze_observation_creates_preview_and_quality(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            source = root / "aa" / "source.jpg"
            source.parent.mkdir(parents=True)
            Image.new("RGB", (1600, 1200), (128, 128, 128)).save(source, "JPEG")
            old_root = os.environ.get("WORLD888_ARTIFACT_ROOT")
            os.environ["WORLD888_ARTIFACT_ROOT"] = str(root)
            try:
                context = JobContext(
                    worker_id=uuid4(),
                    job_id=uuid4(),
                    emit_progress=lambda *_args, **_kwargs: None,
                    is_cancelled=lambda: False,
                    is_pause_requested=lambda: False,
                )
                result = analyze_observation(
                    context,
                    {
                        "parameters": {
                            "observation_id": str(uuid4()),
                            "artifact_id": str(uuid4()),
                            "artifact_token": "aa/source.jpg",
                        }
                    },
                )
            finally:
                if old_root is None:
                    os.environ.pop("WORLD888_ARTIFACT_ROOT", None)
                else:
                    os.environ["WORLD888_ARTIFACT_ROOT"] = old_root

            self.assertEqual(result["kind"], "observation-analysis")
            self.assertEqual(result["quality"]["width"], 1600)
            self.assertEqual(result["quality"]["height"], 1200)
            preview = root / result["preview_token"]
            self.assertTrue(preview.is_file())
            with Image.open(preview) as image:
                self.assertLessEqual(max(image.size), 1024)


if __name__ == "__main__":
    unittest.main()
