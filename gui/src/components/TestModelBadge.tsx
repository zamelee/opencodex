/**
 * 贴在 "当前的拉取方式" 标签右侧的徽章,显示当前生效的 (adapter, auth)。
 * 数据来源:provider 配置(provider.adapter + provider.modelListAuth),
 * 这两个字段由 AuthMatrixPanel 写入并持久化,所以是单一真源。
 *
 * `auto` = 还没在矩阵里点过(AuthMatrixPanel 没探测 / 没锁定 strategy);
 * 锁定后这里就显示具体 strategy 名(Bearer / Anthropic v1 / x-api-key 裸)。
 */
interface Props {
  adapter: string | undefined;
  /** Auth strategy persisted on the provider (`provider.modelListAuth`); null/undefined = auto. */
  modelListAuth: string | null | undefined;
}

const STRATEGY_SHORT: Record<string, string> = {
  "bearer": "Bearer",
  "x-api-key": "x-api-key",
  "x-api-key+anthropic-version": "Anthropic v1",
};

const ADAPTER_SHORT: Record<string, string> = {
  "anthropic": "anthropic",
  "openai-chat": "openai-chat",
  "openai-responses": "openai-responses",
};

export default function TestModelBadge({ adapter, modelListAuth }: Props) {
  const adapterText = adapter ? (ADAPTER_SHORT[adapter] ?? adapter) : "?";
  const authText = modelListAuth ? (STRATEGY_SHORT[modelListAuth] ?? modelListAuth) : "auto";
  return (
    <span
      data-testid="test-model-badge"
      title={`当前矩阵生效:${adapterText} + ${authText}`}
      style={{
        display: "inline-block",
        padding: "2px 8px",
        background: "rgba(88,166,255,0.12)",
        color: "var(--blue)",
        borderRadius: 4,
        fontSize: 11,
        fontWeight: 600,
        fontFamily: "var(--mono, monospace)",
        letterSpacing: 0.2,
      }}
    >
      当前:{adapterText} + {authText}
    </span>
  );
}
