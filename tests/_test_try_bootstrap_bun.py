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


if __name__ == "__main__":
    unittest.main(verbosity=2, exit=False)
