from __future__ import annotations

import importlib.util
from pathlib import Path
import sys
import unittest
from unittest import mock


MODULE_PATH = Path(__file__).resolve().parents[1] / "src" / "figma_cli" / "cli.py"
SPEC = importlib.util.spec_from_file_location("figma_cli", MODULE_PATH)
MODULE = importlib.util.module_from_spec(SPEC)
assert SPEC is not None and SPEC.loader is not None
sys.modules[SPEC.name] = MODULE
SPEC.loader.exec_module(MODULE)


class FigmaURLParsingTest(unittest.TestCase):
    """Figma URL 解析测试。"""

    def test_parse_design_url_with_node_id(self) -> None:
        file_key, node_id = MODULE.parse_figma_url(
            "https://www.figma.com/design/ABC123/MyFile?node-id=1-2"
        )
        self.assertEqual(file_key, "ABC123")
        self.assertEqual(node_id, "1:2")

    def test_parse_file_url(self) -> None:
        file_key, node_id = MODULE.parse_figma_url(
            "https://www.figma.com/file/XYZ789/Project"
        )
        self.assertEqual(file_key, "XYZ789")
        self.assertIsNone(node_id)

    def test_parse_plain_file_key(self) -> None:
        file_key, node_id = MODULE.parse_figma_url("ABC123")
        self.assertEqual(file_key, "ABC123")
        self.assertIsNone(node_id)

    def test_parse_node_id_format(self) -> None:
        file_key, node_id = MODULE.parse_figma_url("1:2")
        self.assertEqual(file_key, "1:2")
        self.assertIsNone(node_id)

    def test_parse_proto_url(self) -> None:
        file_key, node_id = MODULE.parse_figma_url(
            "https://www.figma.com/proto/ABC123/Prototype?node-id=3-4"
        )
        self.assertEqual(file_key, "ABC123")
        self.assertEqual(node_id, "3:4")

    def test_parse_node_id_with_dash(self) -> None:
        file_key, node_id = MODULE.parse_figma_url(
            "https://www.figma.com/design/ABC123/File?node-id=100-200"
        )
        self.assertEqual(file_key, "ABC123")
        self.assertEqual(node_id, "100:200")

    def test_invalid_url_raises(self) -> None:
        with self.assertRaises(MODULE.ToolError):
            MODULE.parse_figma_url("https://google.com/not-figma")


class BackendResolutionTest(unittest.TestCase):
    """后端解析测试。"""

    @mock.patch.dict(MODULE.os.environ, {}, clear=True)
    @mock.patch.object(MODULE, "_check_local_mcp", return_value=False)
    @mock.patch.object(MODULE.shutil, "which", return_value="/usr/local/bin/npx")
    @mock.patch.object(MODULE.subprocess, "run")
    def test_auto_backend_prefers_desktop(self, mock_run, _mock_which, _mock_local) -> None:
        mock_run.return_value = mock.Mock(returncode=0)
        backend = MODULE.resolve_backend()
        self.assertEqual(backend, "desktop")

    @mock.patch.dict(MODULE.os.environ, {"FIGMA_BACKEND": "remote"}, clear=True)
    def test_explicit_backend(self) -> None:
        backend = MODULE.resolve_backend()
        self.assertEqual(backend, "remote")

    @mock.patch.dict(MODULE.os.environ, {}, clear=True)
    @mock.patch.object(MODULE, "_check_local_mcp", return_value=False)
    @mock.patch.object(MODULE.shutil, "which", return_value=None)
    @mock.patch.dict(MODULE.os.environ, {"FIGMA_API_KEY": "figd_test"}, clear=False)
    def test_auto_falls_back_to_remote_when_no_npx(self, _mock_which, _mock_local) -> None:
        backend = MODULE.resolve_backend()
        self.assertEqual(backend, "remote")

    def test_invalid_backend_raises(self) -> None:
        with self.assertRaises(MODULE.ToolError):
            MODULE.resolve_backend("invalid")


class CacheManagerTest(unittest.TestCase):
    """缓存管理测试。"""

    def setUp(self) -> None:
        import tempfile
        self.tmpdir = tempfile.mkdtemp()
        self.cache = MODULE.CacheManager(Path(self.tmpdir))

    def tearDown(self) -> None:
        import shutil
        shutil.rmtree(self.tmpdir, ignore_errors=True)

    def test_write_and_read_cache(self) -> None:
        data = {"key": "value"}
        self.cache.write("FILE001", "get_design_context", data, "1:2")
        cached = self.cache.read("FILE001", "get_design_context", "1:2")
        self.assertIsNotNone(cached)
        assert cached is not None
        self.assertEqual(cached["file_key"], "FILE001")
        self.assertEqual(cached["tool"], "get_design_context")
        self.assertEqual(cached["data"], data)

    def test_read_missing_cache_returns_none(self) -> None:
        self.assertIsNone(self.cache.read("NOPE", "get_design_context"))

    def test_clear_single_file(self) -> None:
        self.cache.write("FILE001", "get_design_context", {"x": 1})
        self.cache.write("FILE002", "get_metadata", {"y": 2})
        count = self.cache.clear("FILE001")
        self.assertEqual(count, 1)
        self.assertIsNone(self.cache.read("FILE001", "get_design_context"))
        self.assertIsNotNone(self.cache.read("FILE002", "get_metadata"))

    def test_clear_all(self) -> None:
        self.cache.write("FILE001", "get_design_context", {"x": 1})
        self.cache.write("FILE002", "get_metadata", {"y": 2})
        count = self.cache.clear()
        self.assertEqual(count, 2)
        self.assertIsNone(self.cache.read("FILE001", "get_design_context"))
        self.assertIsNone(self.cache.read("FILE002", "get_metadata"))


if __name__ == "__main__":
    unittest.main()
