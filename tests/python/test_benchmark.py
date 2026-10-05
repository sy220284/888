from __future__ import annotations

import unittest

from tools.benchmark import ROOT, load_manifest, validate_fixture


class BenchmarkTests(unittest.TestCase):
    def test_smoke_fixture_is_valid(self) -> None:
        fixture = ROOT / "testdata" / "smoke-empty"
        manifest = load_manifest(fixture / "manifest.yaml")
        self.assertEqual(manifest["fixture_id"], "smoke-empty")
        result = validate_fixture(fixture)
        self.assertTrue(result["metrics"]["infrastructure_valid"])
        self.assertEqual(result["metrics"]["observation_count"], 0)


if __name__ == "__main__":
    unittest.main()
