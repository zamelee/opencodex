import { useEffect, useState, useCallback } from "react";
export type AuthStrategy = "bearer" | "x-api-key" | "x-api-key+anthropic-version";
export type SupportedAdapter = "openai-chat" | "openai-responses" | "anthropic";
export const SUPPORTED_ADAPTERS: SupportedAdapter[] = ["openai-chat", "openai-responses", "anthropic"];
const STRATEGY_LABELS: Record<AuthStrategy, string> = {
  "bearer": "Bearer (OpenAI)",
  "x-api-key": "Anthropic legacy (x-api-key 裸)",
  "x-api-key+anthropic-version": "Anthropic v1 (+ version)",
};
interface MatrixCell {
  status: number | "timeout" | "error";
  latencyMs: number;
  ok: boolean;
  modelCount: number;
  error: string | null;
}
export interface MatrixResponse {
  name: string;
  currentAdapter: string;
  currentStrategy: AuthStrategy | null;
  recommended: { adapter: SupportedAdapter; strategy: AuthStrategy } | null;
  adapters: SupportedAdapter[];
  strategies: AuthStrategy[];
  probeTimeoutMs: number;
  rows: Array<{ adapter: SupportedAdapter; cells: Record<AuthStrategy, MatrixCell> }>;
}
interface Props {
  apiBase: string;
  providerName: string;
  onStrategyChanged?: () => void;
}
/**
 * Matrix probe results are cached in localStorage so that (a) reopening the page does
 * not re-probe every provider, and (b) the provider card can auto-expand the matrix
 * when a recent result exists. Bump the TTL if 25s-per-provider probing gets annoying.
 */
const MATRIX_CACHE_TTL_MS = 5 * 60 * 1000;
const matrixCacheKey = (name: string) => `ocx.authMatrix.cache.${name}`;

export interface CachedMatrix { matrix: MatrixResponse; ts: number }

/** Read a fresh (< TTL) cached matrix, or null. Stale entries are pruned. */
export function readMatrixCache(name: string): CachedMatrix | null {
  try {
    const raw = localStorage.getItem(matrixCacheKey(name));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { ts?: number; matrix?: MatrixResponse };
    if (!parsed.matrix || typeof parsed.ts !== "number") return null;
    if (Date.now() - parsed.ts > MATRIX_CACHE_TTL_MS) {
      localStorage.removeItem(matrixCacheKey(name));
      return null;
    }
    return { matrix: parsed.matrix, ts: parsed.ts };
  } catch {
    return null;
  }
}

/** Cheap boolean check for the provider card, which only needs to know whether to auto-expand. */
export function hasFreshMatrixCache(name: string): boolean {
  return readMatrixCache(name) !== null;
}

function writeMatrixCache(name: string, matrix: MatrixResponse): void {
  try {
    localStorage.setItem(matrixCacheKey(name), JSON.stringify({ ts: Date.now(), matrix }));
  } catch { /* private mode / quota — caching is best-effort */ }
}

export default function AuthMatrixPanel({ apiBase, providerName, onStrategyChanged }: Props) {
  const [matrix, setMatrix] = useState<MatrixResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [cachedAt, setCachedAt] = useState<number | null>(null);
  const [saving, setSaving] = useState<AuthStrategy | null>(null);
  const [error, setError] = useState<string | null>(null);
  const probe = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`${apiBase}/api/providers/auth-matrix`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: providerName }),
      });
      const body = await res.json() as MatrixResponse | { error?: string };
      if (!res.ok || !("strategies" in body)) {
        setError(("error" in body && body.error) || `HTTP ${res.status}`);
        setMatrix(null);
        setCachedAt(null);
        return;
      }
      setMatrix(body as MatrixResponse);
      setCachedAt(Date.now());
      writeMatrixCache(providerName, body as MatrixResponse);
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }, [apiBase, providerName]);
  // Reuse a fresh cached probe when the panel mounts again (e.g. after a page
  // navigation) instead of paying the 25s-per-cell probe again. Re-probing is
  // always one click away via the 重新探测 button.
  useEffect(() => {
    const cached = readMatrixCache(providerName);
    if (cached) {
      setMatrix(cached.matrix);
      setCachedAt(cached.ts);
      return;
    }
    probe();
  }, [probe, providerName]);
  const setCell = useCallback(async (adapter: SupportedAdapter, strategy: AuthStrategy | null) => {
    setSaving(strategy);
    setError(null);
    try {
      const res = await fetch(`${apiBase}/api/providers/auth`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: providerName, adapter, strategy }),
      });
      const body = await res.json() as { adapter?: string; modelListAuth?: AuthStrategy | null; error?: string };
      if (!res.ok) {
        setError(body.error || `HTTP ${res.status}`);
        return;
      }
      await probe();
      onStrategyChanged?.();
    } catch (e) {
      setError(String(e));
    } finally {
      setSaving(null);
    }
  }, [apiBase, providerName, probe, onStrategyChanged]);
  return (
    <div className="auth-matrix-panel" style={panelStyle}>
      <div style={headerStyle}>
        <span style={{ fontSize: 12, color: "var(--muted)" }}>
          拉模型认证矩阵 - 探测 /v1/models 用哪种 header
          {cachedAt !== null && !loading && (
            <span style={{ marginLeft: 8, color: "var(--dim)", fontSize: 10.5 }}>
              (缓存 {Math.max(0, Math.round((Date.now() - cachedAt) / 60000))} 分钟前的探测结果)
            </span>
          )}
        </span>
        <button className="btn" onClick={probe} disabled={loading} style={{ fontSize: 11, padding: "3px 10px" }}>
          {loading ? "探测中..." : "重新探测"}
        </button>
      </div>
      {error && (
        <div style={errorStyle}>{error}</div>
      )}
      {matrix && (
        <>
          <div style={{ fontSize: 11, color: "var(--muted)", marginBottom: 6 }}>
            行 = opencodex 的 adapter, 列 = 认证 header. 点击单元格同时切换 adapter + auth.
            <span style={{ marginLeft: 8, color: "var(--dim)" }}>
              ({Math.round((matrix.probeTimeoutMs ?? 25000) / 1000)}s 超时 + 重试 1 次)
            </span>
          </div>
          <table className="auth-matrix-2d" style={tableStyle}>
            <thead>
              <tr>
                <th style={{ ...thStyle, width: "26%" }}>adapter</th>
                {(matrix.strategies ?? []).map((s) => (
                  <th key={s} style={thStyle}>{STRATEGY_LABELS[s]}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {(matrix.rows ?? []).map((row) => {
                const currentAdapter = (matrix.currentAdapter ?? "").toLowerCase();
                const isCurrentRow = row.adapter === currentAdapter;
                const allCellsFailed = !(matrix.strategies ?? []).some((s) => row.cells[s]?.ok);
                return (
                  <tr key={row.adapter} style={{ opacity: allCellsFailed ? 0.5 : 1 }}>
                    <td style={{
                      ...tdStyle,
                      fontFamily: "var(--mono, monospace)",
                      fontSize: 11.5,
                      background: isCurrentRow ? "rgba(88,166,255,0.06)" : undefined,
                      borderLeft: isCurrentRow ? "3px solid var(--blue)" : "3px solid transparent",
                    }}>
                      {row.adapter}
                      {isCurrentRow && <span style={currentTagStyle}>当前 adapter</span>}
                    </td>
                    {(matrix.strategies ?? []).map((s) => {
                      const cell = row.cells[s];
                      if (!cell) return <td key={s} style={{ ...tdStyle, color: "var(--dim)", textAlign: "center" }}>?</td>;
                      const isCurrentCell = isCurrentRow && matrix.currentStrategy === s;
                      const isRecommendedCell = matrix.recommended?.adapter === row.adapter && matrix.recommended?.strategy === s;
                      const clickable = (cell.ok || isCurrentCell) && !saving;
                      const baseBg = isCurrentCell
                        ? "rgba(88,166,255,0.10)"
                        : cell.ok
                          ? isRecommendedCell ? "rgba(63,185,80,0.06)" : "transparent"
                          : "transparent";
                      const statusColor = cell.ok ? "var(--green)" : "var(--red)";
                      return (
                        <td
                          key={s}
                          onClick={clickable ? () => setCell(row.adapter, isCurrentCell ? null : s) : undefined}
                          title={
                            isCurrentCell ? "点击清除, 回到自动检测"
                              : cell.ok ? `点击切换到 ${row.adapter} + ${STRATEGY_LABELS[s]}`
                              : "此组合探测失败"
                          }
                          onMouseEnter={(e) => {
                            if (clickable && !isCurrentCell) {
                              (e.currentTarget as HTMLElement).style.background = "rgba(88,166,255,0.15)";
                              (e.currentTarget as HTMLElement).style.boxShadow = "inset 0 0 0 1px var(--blue)";
                            }
                          }}
                          onMouseLeave={(e) => {
                            if (!isCurrentCell) {
                              (e.currentTarget as HTMLElement).style.background = baseBg;
                              (e.currentTarget as HTMLElement).style.boxShadow = "none";
                            }
                          }}
                          style={{
                            ...tdStyle,
                            cursor: clickable ? "pointer" : "default",
                            background: baseBg,
                            border: isCurrentCell ? "1px solid var(--blue)" : "1px solid transparent",
                            color: statusColor,
                            fontFamily: "var(--mono, monospace)",
                            fontSize: 11,
                            textAlign: "center",
                            transition: "background 0.1s, box-shadow 0.1s",
                          }}
                        >
                          <div>{cell.ok ? "✓" : "✗"} {cell.ok ? `${cell.modelCount}个` : cell.status}</div>
                          {clickable && !isCurrentCell && (
                            <div style={{ fontSize: 9, color: "var(--blue)", marginTop: 2, opacity: 0.7 }}>点击应用</div>
                          )}
                          <div style={{ fontSize: 9.5, color: "var(--muted)", marginTop: 1 }}>{cell.latencyMs}ms</div>
                          {isCurrentCell && <div style={{ ...currentTagStyle, marginTop: 2, fontSize: 9 }}>当前</div>}
                          {isRecommendedCell && !isCurrentCell && <div style={{ ...recTagStyle, marginTop: 2, fontSize: 9 }}>推荐</div>}
                        </td>
                      );
                    })}
                  </tr>
                );
              })}
            </tbody>
          </table>
          <div style={footerStyle}>
            {matrix.currentStrategy
              ? <>当前: <code style={{ color: "var(--blue)" }}>{matrix.currentAdapter || "?"}</code> + <code style={{ color: "var(--blue)" }}>{STRATEGY_LABELS[matrix.currentStrategy]}</code></>
              : <>自动检测 → <code style={{ color: "var(--green)" }}>{matrix.recommended ? `${matrix.recommended.adapter} + ${STRATEGY_LABELS[matrix.recommended.strategy]}` : "(探测中, 无可用组合)"}</code></>}
            {matrix.currentStrategy && (
              <> {" · "}
                <button
                  className="btn-link"
                  onClick={() => setCell(matrix.currentAdapter as SupportedAdapter, null)}
                  disabled={saving !== null}
                  style={clearBtnStyle}
                >
                  清除固定值
                </button>
              </>
            )}
          </div>
        </>
      )}
    </div>
  );
}
const panelStyle: React.CSSProperties = {
  margin: "10px 0 0 0",
  padding: "12px 14px",
  background: "var(--card-2)",
  border: "1px solid var(--border)",
  borderRadius: 8,
};
const headerStyle: React.CSSProperties = {
  display: "flex",
  justifyContent: "space-between",
  alignItems: "center",
  marginBottom: 10,
};
const errorStyle: React.CSSProperties = {
  padding: "8px 12px",
  background: "rgba(248,81,73,0.08)",
  borderLeft: "3px solid var(--red)",
  color: "var(--red)",
  fontSize: 12,
  borderRadius: 4,
  marginBottom: 10,
};
const tableStyle: React.CSSProperties = {
  width: "100%",
  borderCollapse: "collapse",
  fontSize: 12,
};
const thStyle: React.CSSProperties = {
  padding: "6px 8px",
  textAlign: "left",
  color: "var(--muted)",
  fontWeight: 500,
  borderBottom: "1px solid var(--border)",
  textTransform: "uppercase",
  fontSize: 10,
  letterSpacing: 0.5,
};
const tdStyle: React.CSSProperties = {
  padding: "8px",
  borderBottom: "1px solid var(--border)",
};
const currentTagStyle: React.CSSProperties = {
  display: "inline-block",
  marginLeft: 6,
  padding: "1px 6px",
  background: "rgba(88,166,255,0.18)",
  color: "var(--blue)",
  borderRadius: 3,
  fontSize: 10,
  fontWeight: 600,
};
const recTagStyle: React.CSSProperties = {
  display: "inline-block",
  marginLeft: 6,
  padding: "1px 6px",
  background: "rgba(63,185,80,0.18)",
  color: "var(--green)",
  borderRadius: 3,
  fontSize: 10,
  fontWeight: 600,
};
const clearBtnStyle: React.CSSProperties = {
  background: "transparent",
  border: "none",
  color: "var(--muted)",
  cursor: "pointer",
  fontSize: 11,
  padding: 0,
  textDecoration: "underline",
};
const footerStyle: React.CSSProperties = {
  marginTop: 10,
  fontSize: 11,
  color: "var(--muted)",
};
