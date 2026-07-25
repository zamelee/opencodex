/**
 * Cross-context clipboard write.
 *
 * navigator.clipboard.writeText() requires a secure context (HTTPS or
 * loopback hostnames per HTML spec). When the proxy is reached over a LAN
 * address such as http://192.168.x.x:10100 the browser treats it as
 * non-secure and rejects the call with "Clipboard write was blocked due
 * to lack of user activation" or "Blocked due to insecure context".
 *
 * Fallback path uses the legacy document.execCommand("copy") on a hidden
 * textarea. Deprecated by spec but every desktop browser still honours
 * it within user-activated handlers. If both paths fail we return false
 * so the caller can surface a localized error.
 */
export async function copyToClipboard(text: string): Promise<boolean> {
  if (typeof window === "undefined") return false;
  // Modern path: secure context + clipboard API available
  if (window.isSecureContext && navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      // fall through to legacy path
    }
  }
  // Legacy fallback: hidden textarea + execCommand. Works in non-secure
  // contexts (LAN-IP HTTP) as long as the call is inside a user-activated
  // event handler.
  try {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.setAttribute("readonly", "");
    ta.style.position = "fixed";
    ta.style.top = "0";
    ta.style.left = "-9999px";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.focus();
    ta.select();
    let ok = false;
    try {
      ok = document.execCommand("copy");
    } finally {
      document.body.removeChild(ta);
    }
    return ok;
  } catch {
    return false;
  }
}
