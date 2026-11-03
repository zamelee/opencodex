/**
 * 共享的密钥测试结果弹窗。两个 Tab:
 *  - 余量探测:旧的 /v1/messages ping(max_tokens=1),只回报 ok + latencyMs
 *  - 测试:新的 chat-test(max_tokens=100),回报 reply + usage
 *
 * 父组件 Providers.tsx 持有两份 state(keyTests / keyChatTests),
 * 点击 KeyPoolPanel 上的两个按钮后,把结果塞进来并打开本弹窗。
 */
import { useEffect, useState } from "react";

export interface QuotaProbeResult {
  status: "ok" | "fail" | "unknown" | "loading";
  latencyMs?: number;
  error?: string;
}

export interface ChatTestResult {
  status: "ok" | "fail" | "loading";
  latencyMs?: number;
  reply?: string;
  usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
  error?: string;
  model?: string;
}

interface Props {
  open: boolean;
  onClose: () => void;
  /** Which pane to show first. Set by whichever button opened the dialog. */
  initialTab?: "quota" | "chat";
  /** 显示用 key 标签(默认走 masked + index) */
  keyLabel: string;
  /** 当前生效的 (adapter, auth),用于弹窗头 */
  adapter: string;
  strategy: string;
  /** Tab 1:余量探测结果 */
  quota: QuotaProbeResult | null;
  /** Tab 2:真实 chat 测试结果 */
  chat: ChatTestResult | null;
  /** Tab 标题 i18n key */
  tQuota: string;
  tChat: string;
  /** 复用 i18n 通用字符串 */
  tClose: string;
}

export default function KeyTestResultDialog({
  open, onClose, initialTab = "quota", keyLabel, adapter, strategy,
  quota, chat, tQuota, tChat, tClose,
}: Props) {
  const [tab, setTab] = useState<"quota" | "chat">(initialTab);

  // The dialog stays mounted while results stream in, so re-focus the pane each time
  // it is opened from the other button.
  useEffect(() => { if (open) setTab(initialTab); }, [open, initialTab]);

  if (!open) return null;

  const tabBtn = (key: "quota" | "chat", label: string, hasData: boolean) => (
    <button
      type="button"
      onClick={() => setTab(key)}
      disabled={!hasData}
      style={{
        background: tab === key ? "var(--raised)" : "transparent",
        color: tab === key ? "var(--text)" : hasData ? "var(--muted)" : "var(--dim)",
        border: "none",
        borderBottom: tab === key ? "2px solid var(--blue)" : "2px solid transparent",
        padding: "8px 14px",
        fontSize: 12,
        fontWeight: tab === key ? 600 : 400,
        cursor: hasData ? "pointer" : "not-allowed",
        opacity: hasData ? 1 : 0.5,
      }}
    >
      {label}
    </button>
  );

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={`key test results for ${keyLabel}`}
      onClick={onClose}
      style={{
        position: "fixed", inset: 0, background: "rgba(0,0,0,0.5)",
        display: "flex", alignItems: "center", justifyContent: "center", zIndex: 1000,
      }}
    >
      <div
        onClick={e => e.stopPropagation()}
        style={{
          background: "var(--bg, #0f172a)",
          border: "1px solid var(--border)",
          borderRadius: 10,
          width: "min(560px, 92vw)",
          maxHeight: "85vh",
          display: "flex",
          flexDirection: "column",
          fontSize: 12,
        }}
      >
        <div style={{
          padding: "12px 16px",
          borderBottom: "1px solid var(--border)",
          display: "flex", alignItems: "center", gap: 8,
        }}>
          <span style={{ fontWeight: 600 }}>{keyLabel}</span>
          <span className="muted" style={{ fontSize: 11 }}>·</span>
          <code style={{
            padding: "2px 6px", background: "var(--raised)",
            borderRadius: 3, fontSize: 11, color: "var(--blue)",
          }}>
            {adapter} + {strategy}
          </code>
        </div>

        <div style={{ display: "flex", borderBottom: "1px solid var(--border)" }}>
          {tabBtn("quota", tQuota, quota !== null)}
          {tabBtn("chat", tChat, chat !== null)}
        </div>

        <div style={{ padding: 16, overflowY: "auto", flex: 1 }}>
          {tab === "quota" && quota && (
            <QuotaPanel q={quota} />
          )}
          {tab === "chat" && chat && (
            <ChatPanel c={chat} />
          )}
        </div>

        <div style={{
          padding: "10px 16px",
          borderTop: "1px solid var(--border)",
          display: "flex", justifyContent: "flex-end",
        }}>
          <button type="button" className="btn btn-ghost btn-sm" onClick={onClose}>
            {tClose}
          </button>
        </div>
      </div>
    </div>
  );
}

function QuotaPanel({ q }: { q: QuotaProbeResult }) {
  if (q.status === "loading") return <span className="muted">探测中…</span>;
  const color =
    q.status === "ok" ? "var(--green)" :
    q.status === "fail" ? "var(--red)" :
    "var(--muted)";
  const label =
    q.status === "ok" ? "通过" :
    q.status === "fail" ? "被拒" :
    "未知";
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      <div>
        <span style={{ color, fontWeight: 600, fontSize: 14 }}>{label}</span>
        {q.latencyMs !== undefined && (
          <span className="muted" style={{ marginLeft: 8 }}>· {q.latencyMs} ms</span>
        )}
      </div>
      {q.error && (
        <pre style={{
          padding: 10, background: "var(--raised)", borderRadius: 4,
          fontSize: 11, color: "var(--red)", whiteSpace: "pre-wrap", wordBreak: "break-word",
          maxHeight: 240, overflowY: "auto", margin: 0,
        }}>{q.error}</pre>
      )}
    </div>
  );
}

function ChatPanel({ c }: { c: ChatTestResult }) {
  if (c.status === "loading") return <span className="muted">对话中…</span>;
  const color = c.status === "ok" ? "var(--green)" : "var(--red)";
  const label = c.status === "ok" ? "通过" : "失败";
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
      <div>
        <span style={{ color, fontWeight: 600, fontSize: 14 }}>{label}</span>
        {c.latencyMs !== undefined && (
          <span className="muted" style={{ marginLeft: 8 }}>· {c.latencyMs} ms</span>
        )}
        {c.model && (
          <span className="muted" style={{ marginLeft: 8 }}>· model {c.model}</span>
        )}
      </div>

      {c.reply && (
        <div>
          <div className="muted" style={{ fontSize: 10, marginBottom: 4 }}>回复</div>
          <pre style={{
            padding: 10, background: "var(--raised)", borderRadius: 4,
            fontSize: 12, whiteSpace: "pre-wrap", wordBreak: "break-word",
            maxHeight: 200, overflowY: "auto", margin: 0,
          }}>{c.reply}</pre>
        </div>
      )}

      {c.usage && (
        <div style={{ display: "flex", gap: 12, fontSize: 11, color: "var(--muted)" }}>
          {c.usage.prompt_tokens !== undefined && (
            <span>prompt <strong style={{ color: "var(--text)" }}>{c.usage.prompt_tokens}</strong></span>
          )}
          {c.usage.completion_tokens !== undefined && (
            <span>completion <strong style={{ color: "var(--text)" }}>{c.usage.completion_tokens}</strong></span>
          )}
          {c.usage.total_tokens !== undefined && (
            <span>total <strong style={{ color: "var(--text)" }}>{c.usage.total_tokens}</strong></span>
          )}
        </div>
      )}

      {c.error && (
        <pre style={{
          padding: 10, background: "var(--raised)", borderRadius: 4,
          fontSize: 11, color: "var(--red)", whiteSpace: "pre-wrap", wordBreak: "break-word",
          maxHeight: 240, overflowY: "auto", margin: 0,
        }}>{c.error}</pre>
      )}
    </div>
  );
}
