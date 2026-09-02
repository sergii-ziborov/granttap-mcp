/**
 * Consent and pairing POSTs are loopback-only. Block foreign https origins,
 * but allow Cursor's Settings webview, which submits with a vscode-webview Origin
 * even though the form page itself was served from 127.0.0.1.
 */
export function isAllowedLoopbackOrigin(
  origin: string | undefined,
  issuerOrigin: string,
): boolean {
  if (!origin) return true;
  if (origin === issuerOrigin) return true;
  const lower = origin.toLowerCase();
  return lower.startsWith("vscode-webview:")
    || lower.startsWith("cursor:")
    || lower === "null";
}
