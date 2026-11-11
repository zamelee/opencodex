"""槽位标签：把上游 id 换成人能认出来的说法。

槽位顺序 = 上游在列表里的顺序（storage.list_upstreams 按创建时间排序），
与前端拓扑图的 SLOT_NAMES 保持一致：
   第 1 个 = 主通道，第 2 个 = 备通道，第 3 个起 = 通道 N。

日志里到处打内部 id（120ebe055898）没人认得出来，统一走这里。
"""

from __future__ import annotations

SLOT_LABELS = ["主通道", "备通道"]


def slot_label(index: int) -> str:
    if index < len(SLOT_LABELS):
        return SLOT_LABELS[index]
    return f"通道 {index + 1}"


def upstream_label(upstreams, upstream_id: str) -> str:
    """返回「槽位 通道名」，找不到就退回 id 本身。"""
    for i, u in enumerate(upstreams):
        if u.id != upstream_id:
            continue
        name = (u.name or "").strip()
        tag = slot_label(i)
        return f"{tag} {name}" if name else f"{tag} {u.id}"
    return upstream_id
