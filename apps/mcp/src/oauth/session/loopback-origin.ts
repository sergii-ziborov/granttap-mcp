/**
 * Consent and pairing POSTs are loopback-only. Block foreign https origins,
 * but allow Cursor's Settings webview, which submits with a vscode-webview Origin
 * even though the form page itself was served from 127.0.0.1.
 */
export const WEBSITE_ORIGINS = ["https://granttap.com", "https://relay.granttap.com"] as const;

export function isWebsiteOrigin(origin: string | undefined): boolean {
  return origin === "https://granttap.com" || origin === "https://relay.granttap.com";
}

export function isAllowedLoopbackOrigin(
  origin: string | undefined,
  issuerOrigin: string,
): boolean {
  if (!origin) return true;
  if (origin === issuerOrigin) return true;
  if (isWebsiteOrigin(origin)) return true;
  const lower = origin.toLowerCase();
  return lower.startsWith("vscode-webview:")
    || lower.startsWith("cursor:")
    || lower === "null";
}
