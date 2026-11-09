/**
 * Per-provider visual identity: a left-border accent + a faint tinted background,
 * picked by adapter so each provider card is recognisable at a glance even before
 * the user reads the URL/adapter chip. Colors lean into the existing palette
 * (warm/cool/violet/green) without colliding with the default blue used for the
 * default-provider badge.
 *
 * Shared by the Providers page (the cards) and the Logs page (the rows), so a
 * provider looks the SAME in both places.
 */
export interface ProviderAccent {
  border: string;
  tint: string;
}

export function providerAccent(adapter: string | undefined): ProviderAccent {
  const a = (adapter ?? "").toLowerCase();
  if (a.startsWith("anthropic")) return { border: "#e09a5f", tint: "rgba(224,154,95,0.06)" };
  if (a === "openai-chat") return { border: "#5fb1e3", tint: "rgba(95,177,227,0.06)" };
  if (a === "openai-responses") return { border: "#a285f5", tint: "rgba(162,133,245,0.06)" };
  if (a.startsWith("google")) return { border: "#5fc18a", tint: "rgba(95,193,138,0.06)" };
  if (a.startsWith("xai")) return { border: "#c98ad6", tint: "rgba(201,138,214,0.06)" };
  if (a === "kimi") return { border: "#d6c25f", tint: "rgba(214,194,95,0.06)" };
  if (a === "kiro") return { border: "#e35f7f", tint: "rgba(227,95,127,0.06)" };
  if (a === "cursor") return { border: "#7fc9c8", tint: "rgba(127,201,200,0.06)" };
  if (a === "chatgpt" || a === "openai-responses-forward") return { border: "#7a7a7a", tint: "rgba(122,122,122,0.05)" };
  return { border: "var(--blue)", tint: "rgba(88,166,255,0.05)" };
}

/**
 * The accent color as TEXT: mixed toward the current theme's text color so it
 * stays readable in both light and dark mode (the raw accent is a pastel that
 * is fine as a border but washes out as small text on a light background).
 */
export function providerAccentText(accent: ProviderAccent): string {
  return `color-mix(in srgb, ${accent.border} 72%, var(--text))`;
}
