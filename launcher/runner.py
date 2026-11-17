"""子进程执行器。

两个要点：
1. Windows 上用 CREATE_NO_WINDOW，别弹出命令行黑框；
2. 输出要能流式取回（UI 上滚动的日志），所以按行读、不缓冲到结束。
"""

from __future__ import annotations

import os
import subprocess
import threading
import time
import uuid
from collections import deque

CREATE_NO_WINDOW = 0x08000000 if os.name == "nt" else 0


class Job:
    """一次动作的执行记录。"""

    def __init__(self, label: str, argv: list[str], cwd: str | None) -> None:
        self.id = uuid.uuid4().hex[:8]
        self.label = label
        self.argv = list(argv)
        self.cwd = cwd
        self.started_at = time.time()
        self.finished_at: float | None = None
        self.state = "running"  # running | done | failed | canceled
        self.rc: int | None = None
        self.lines: deque = deque(maxlen=4000)
        self.seq = 0
        self.proc: subprocess.Popen | None = None
        self._lock = threading.Lock()

    def push(self, text: str) -> None:
        with self._lock:
            self.seq += 1
            self.lines.append({"seq": self.seq, "text": text})

    def snapshot(self) -> dict:
        return {
            "id": self.id,
            "label": self.label,
            "argv": self.argv,
            "state": self.state,
            "rc": self.rc,
            "started_at": self.started_at,
            "finished_at": self.finished_at,
            "seq": self.seq,
        }

    def tail(self, since: int = 0, limit: int = 500) -> list[dict]:
        with self._lock:
            items = [x for x in self.lines if x["seq"] > since]
        return items[-limit:]


class Runner:
    """管理所有子进程作业。"""

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._jobs: dict[str, Job] = {}
        self._order: deque = deque(maxlen=50)

    def start(
        self,
        label: str,
        argv: list[str],
        cwd: str | None = None,
        env: dict | None = None,
    ) -> Job:
        job = Job(label, argv, cwd)
        flags = CREATE_NO_WINDOW if os.name == "nt" else 0
        job.proc = subprocess.Popen(
            argv,
            cwd=cwd,
            env=env,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            stdin=subprocess.DEVNULL,
            text=True,
            encoding="utf-8",
            errors="replace",
            bufsize=1,
            creationflags=flags,
        )
        with self._lock:
            self._jobs[job.id] = job
            self._order.append(job.id)
        threading.Thread(
            target=self._pump, args=(job,), daemon=True, name=f"ocx-job-{job.id}"
        ).start()
        return job

    def _pump(self, job: Job) -> None:
        proc = job.proc
        try:
            if proc is not None and proc.stdout is not None:
                for raw in proc.stdout:
                    line = raw.rstrip("\n").rstrip("\r")
                    job.push(line)
            rc = proc.wait() if proc is not None else -1
            job.rc = rc
            job.state = "done" if rc == 0 else "failed"
            if job.state == "done":
                job.push("[launcher] 完成")
            else:
                job.push(f"[launcher] 退出码 {rc}")
        except Exception as exc:  # noqa: BLE001
            job.push(f"[launcher] 执行异常: {exc}")
            job.state = "failed"
            job.rc = -1
        finally:
            job.finished_at = time.time()

    def cancel(self, job_id: str) -> bool:
        job = self._jobs.get(job_id)
        if job is None or job.proc is None or job.state != "running":
            return False
        try:
            job.proc.terminate()
            job.state = "canceled"
            job.push("[launcher] 已取消")
        except Exception:
            return False
        return True

    def get(self, job_id: str) -> Job | None:
        return self._jobs.get(job_id)

    def latest(self) -> Job | None:
        with self._lock:
            if not self._order:
                return None
            return self._jobs.get(self._order[-1])

    def recent(self, limit: int = 10) -> list[dict]:
        with self._lock:
            ids = list(self._order)[-limit:]
        return [self._jobs[i].snapshot() for i in reversed(ids) if i in self._jobs]

    def any_running(self) -> bool:
        return any(j.state == "running" for j in self._jobs.values())
