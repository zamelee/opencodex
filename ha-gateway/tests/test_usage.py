"""用量落库与统计。"""

from ha_gateway.storage import Storage


def _upstream(storage, name):
    from ha_gateway.models import Upstream

    return storage.add_upstream(
        Upstream(
            id="",
            name=name,
            provider="p",
            base_url="http://127.0.0.1:1",
            api_key="k",
            protocol="openai-responses",
        )
    )


def test_usage_record_and_summary(tmp_path):
    db = tmp_path / "u.db"
    with Storage(str(db)) as s:
        a = _upstream(s, "通道甲")
        s.add_usage_record(
            rid="r1",
            upstream_id=a.id,
            upstream_name=a.name,
            model="gpt-4o-mini",
            status=200,
            input_tokens=10,
            output_tokens=5,
            total_tokens=15,
            ttfb_ms=12.0,
        )
        s.add_usage_record(
            rid="r2",
            upstream_id=a.id,
            upstream_name=a.name,
            model="gpt-4o-mini",
            status=500,
            input_tokens=None,
            output_tokens=None,
            total_tokens=None,
            ttfb_ms=3.0,
        )
        s.add_usage_record(
            rid="r3",
            upstream_id=a.id,
            upstream_name="通道乙",
            model="gpt-4o-mini",
            status=200,
            input_tokens=1,
            output_tokens=2,
            total_tokens=3,
            ttfb_ms=1.0,
        )
        summary = s.usage_summary(7)
        assert summary["total"]["requests"] == 3
        assert summary["total"]["input_tokens"] == 11
        assert summary["total"]["output_tokens"] == 7
        assert summary["total"]["total_tokens"] == 18
        assert len(summary["by_day"]) == 1
        names = {u["name"] for u in summary["by_upstream"]}
        assert names == {"通道甲", "通道乙"}


def test_prune_usage(tmp_path):
    db = tmp_path / "u2.db"
    with Storage(str(db)) as s:
        s.add_usage_record(
            rid="r1",
            upstream_id="x",
            upstream_name="n",
            model="m",
            status=200,
            input_tokens=1,
            output_tokens=1,
            total_tokens=2,
            ttfb_ms=1.0,
        )
        assert s.prune_usage(keep_days=90) == 0
        assert s.prune_usage(keep_days=0) == 1
        assert s.usage_summary(7)["total"]["requests"] == 0
