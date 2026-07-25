#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Unit tests for try_bootstrap_bun in ocx-start.py."""

import importlib.util
import io
import sys
import unittest
from contextlib import redirect_stderr
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SPEC = importlib.util.spec_from_file_location("ocx_start", ROOT / "ocx-start.py")
mod = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(mod)


class TryBootstrapBunTests(unittest.TestCase):
    def setUp(self):
        self._orig_which = mod.shutil.which
        self._orig_call = mod.subprocess.call
        self._orig_has_bun = mod.has_bun

    def tearDown(self):
        mod.shutil.which = self._orig_which
        mod.subprocess.call = self._orig_call
        mod.has_bun = self._orig_has_bun

    def _capture_stderr(self, fn):
        buf = io.StringIO()
        with redirect_stderr(buf):
            rv = fn()
        return rv, buf.getvalue()

    def test_s1_bun_present(self):
        mod.has_bun = lambda: True
        mod.shutil.which = lambda *_: self.fail("which should not be called")
        mod.subprocess.call = lambda *_: self.fail("call should not be called")
        rv, err = self._capture_stderr(lambda: mod.try_bootstrap_bun())
        self.assertTrue(rv)
        self.assertEqual(err, "")

    def test_s2_non_interactive(self):
        mod.has_bun = lambda: False
        rv, err = self._capture_stderr(lambda: mod.try_bootstrap_bun(non_interactive=True))
        self.assertFalse(rv)
        self.assertIn("[err] 未检测到 bun", err)
        self.assertIn("--no-auto-bootstrap", err)

    def test_s3_no_pkg_mgr(self):
        mod.has_bun = lambda: False
        mod.shutil.which = lambda name: None
        mod.subprocess.call = lambda *_: self.fail("subprocess.call must NOT run")
        rv, err = self._capture_stderr(lambda: mod.try_bootstrap_bun())
        self.assertFalse(rv)
        self.assertIn("[hint] 未检测到任何 Node 包管理器", err)
        self.assertIn("Node.js LTS", err)
        self.assertIn("winget install --id=Oven-sh.Bun -e", err)
        self.assertIn("irm bun.sh/install.ps1 | iex", err)
        self.assertIn("scoop install bun", err)
        self.assertIn("[err] 自动安装 bun 失败", err)

    def test_s4_npm_present_but_fails(self):
        mod.has_bun = lambda: False
        mod.shutil.which = lambda name: "C:/fake/" + name if name == "npm" else None
        mod.subprocess.call = lambda cmd, **kw: 1
        rv, err = self._capture_stderr(lambda: mod.try_bootstrap_bun())
        self.assertFalse(rv)
        self.assertIn("[bootstrap] npm install -g bun", err)
        self.assertIn("[bootstrap] npm 装 bun 返 exit=1", err)
        self.assertIn("[hint] npm 存在但装 bun 失败", err)
        self.assertIn("网络问题", err)
        self.assertIn("winget install --id=Oven-sh.Bun -e", err)
        self.assertIn("irm bun.sh/install.ps1 | iex", err)

    def test_s5_npm_succeeds(self):
        calls = []
        def fake_which(name):
            return "C:/fake/" + name if name == "npm" else None
        def fake_call(cmd, **kw):
            calls.append(cmd)
            return 0
        which_calls = [0]
        def fake_has_bun():
            which_calls[0] += 1
            return which_calls[0] >= 2
        mod.shutil.which = fake_which
        mod.subprocess.call = fake_call
        mod.has_bun = fake_has_bun
        rv, err = self._capture_stderr(lambda: mod.try_bootstrap_bun())
        self.assertTrue(rv)
        self.assertIn("[bootstrap] bun 安装成功", err)
        self.assertEqual(len(calls), 1)
        self.assertEqual(calls[0][:2], ["npm", "install"])

    def test_s6_falls_through_to_pnpm(self):
        state = {"i": 0}
        def fake_which(name):
            return "C:/fake/" + name if name in ("npm", "pnpm") else None
        def fake_call(cmd, **kw):
            return 0 if cmd[0] == "pnpm" else 1
        def fake_has_bun():
            state["i"] += 1
            return state["i"] >= 2
        mod.shutil.which = fake_which
        mod.subprocess.call = fake_call
        mod.has_bun = fake_has_bun
        rv, err = self._capture_stderr(lambda: mod.try_bootstrap_bun())
        self.assertTrue(rv)
        self.assertIn("[bootstrap] bun 安装成功", err)




class FindBunExeTests(unittest.TestCase):
    def setUp(self):
        self._orig_which = mod.shutil.which
    def tearDown(self):
        mod.shutil.which = self._orig_which

    def test_find_bun_exe_returns_none_when_no_bun(self):
        mod.shutil.which = lambda name: None
        self.assertIsNone(mod.find_bun_exe())

    def test_find_bun_exe_returns_resolved_absolute(self):
        mod.shutil.which = lambda name: "C:/Users/X/AppData/Roaming/npm/bun.cmd"
        result = mod.find_bun_exe()
        self.assertIsInstance(result, str)
        self.assertTrue(result.endswith("bun.cmd"))


class RunCliPathResolutionTests(unittest.TestCase):
    def setUp(self):
        self._orig_find = mod.find_bun_exe
        self._orig_call = mod.subprocess.call
    def tearDown(self):
        mod.find_bun_exe = self._orig_find
        mod.subprocess.call = self._orig_call

    def test_run_cli_uses_absolute_bun_path_in_cmd(self):
        mod.find_bun_exe = lambda: "C:/some/path/bun.exe"
        captured = {}
        def fake_call(cmd, **kw):
            captured["cmd0"] = cmd[0]
            return 0
        mod.subprocess.call = fake_call
        import io, contextlib
        buf = io.StringIO()
        with contextlib.redirect_stderr(buf):
            rc = mod.run_cli("init")
        self.assertEqual(rc, 0)
        self.assertEqual(captured["cmd0"], "C:/some/path/bun.exe")
        self.assertIn("C:/some/path/bun.exe run src/cli/index.ts init", buf.getvalue())
        self.assertNotIn("'bun' run", buf.getvalue())

    def test_run_cli_no_bun_after_bootstrap_returns_127(self):
        mod.find_bun_exe = lambda: None
        orig_tbb = mod.try_bootstrap_bun
        mod.try_bootstrap_bun = lambda non_interactive=False: False
        try:
            import io, contextlib
            buf = io.StringIO()
            with contextlib.redirect_stderr(buf):
                rv = mod.run_cli("init")
        finally:
            mod.try_bootstrap_bun = orig_tbb
        self.assertEqual(rv, 127)

    def test_run_cli_post_install_path_disappeared(self):
        seq = ["C:/path/bun.exe", None]
        mod.find_bun_exe = lambda: seq.pop(0) if seq else None
        orig_tbb = mod.try_bootstrap_bun
        mod.try_bootstrap_bun = lambda non_interactive=False: True
        try:
            import io, contextlib
            buf = io.StringIO()
            with contextlib.redirect_stderr(buf):
                rv = mod.run_cli("init")
        finally:
            mod.try_bootstrap_bun = orig_tbb
        self.assertEqual(rv, 127)
        self.assertIn("\u65e0\u6cd5\u542f\u52a8", buf.getvalue())




class EnsureDepsInstalledTests(unittest.TestCase):
    def setUp(self):
        self._orig_call = mod.subprocess.call
        self._orig_find = getattr(mod, "find_bun_exe", None)

    def tearDown(self):
        mod.subprocess.call = self._orig_call
        if self._orig_find is not None:
            mod.find_bun_exe = self._orig_find

    def test_no_package_json_returns_true(self):
        import tempfile, pathlib
        with tempfile.TemporaryDirectory() as td:
            orig_root = mod.ROOT
            mod.ROOT = pathlib.Path(td)
            try:
                rv = mod.ensure_deps_installed()
                self.assertTrue(rv)
            finally:
                mod.ROOT = orig_root

    def test_node_modules_present_returns_true_no_call(self):
        import tempfile, pathlib
        with tempfile.TemporaryDirectory() as td:
            td_path = pathlib.Path(td)
            (td_path / "package.json").write_text("{}", encoding="utf-8")
            (td_path / "node_modules").mkdir()
            orig_root = mod.ROOT
            orig_call = mod.subprocess.call
            mod.ROOT = td_path
            mod.subprocess.call = lambda *_, **__: self.fail("bun install must not run")
            try:
                rv = mod.ensure_deps_installed()
                self.assertTrue(rv)
            finally:
                mod.ROOT = orig_root
                mod.subprocess.call = orig_call

    def test_node_modules_missing_runs_bun_install(self):
        import tempfile, pathlib
        calls = []
        def fake_call(cmd, **kw):
            calls.append(cmd)
            return 0
        with tempfile.TemporaryDirectory() as td:
            td_path = pathlib.Path(td)
            (td_path / "package.json").write_text("{}", encoding="utf-8")
            orig_root = mod.ROOT
            mod.ROOT = td_path
            mod.find_bun_exe = lambda: "C:/fake/bun.exe"
            mod.subprocess.call = fake_call
            try:
                import io, contextlib
                buf = io.StringIO()
                with contextlib.redirect_stderr(buf):
                    rv = mod.ensure_deps_installed()
                self.assertTrue(rv)
                self.assertEqual(len(calls), 1)
                self.assertEqual(calls[0], ["C:/fake/bun.exe", "install"])
                self.assertIn("bun install", buf.getvalue())
            finally:
                mod.ROOT = orig_root

    def test_bun_install_returns_nonzero_returns_false(self):
        import tempfile, pathlib
        with tempfile.TemporaryDirectory() as td:
            td_path = pathlib.Path(td)
            (td_path / "package.json").write_text("{}", encoding="utf-8")
            orig_root = mod.ROOT
            mod.ROOT = td_path
            mod.find_bun_exe = lambda: "C:/fake/bun.exe"
            mod.subprocess.call = lambda *_, **__: 1
            try:
                import io, contextlib
                buf = io.StringIO()
                with contextlib.redirect_stderr(buf):
                    rv = mod.ensure_deps_installed()
                self.assertFalse(rv)
                self.assertIn("失败", buf.getvalue())
            finally:
                mod.ROOT = orig_root

    def test_no_bun_returns_false_quiet(self):
        import tempfile, pathlib
        with tempfile.TemporaryDirectory() as td:
            td_path = pathlib.Path(td)
            (td_path / "package.json").write_text("{}", encoding="utf-8")
            orig_root = mod.ROOT
            mod.ROOT = td_path
            mod.find_bun_exe = lambda: None
            mod.subprocess.call = lambda *_, **__: self.fail("must not call without bun")
            try:
                rv_quiet = mod.ensure_deps_installed(quiet=True)
                self.assertFalse(rv_quiet)
                import io, contextlib
                buf = io.StringIO()
                with contextlib.redirect_stderr(buf):
                    rv_loud = mod.ensure_deps_installed(quiet=False)
                self.assertFalse(rv_loud)
                self.assertIn("跳过", buf.getvalue())
            finally:
                mod.ROOT = orig_root


if __name__ == "__main__":
    unittest.main(verbosity=2, exit=False)
