/**
 * The GrantTap account service every process on this computer talks to: granttap.com, or
 * `GRANTTAP_WEBSITE_ORIGIN` for a local test site. Tests and `GRANTTAP_SKIP_WEBSITE=1` get none, so
 * nothing in them polls or signs in against the real service.
 */
export function accountServiceOrigin(): string | undefined {
  const raw = process.env.GRANTTAP_WEBSITE_ORIGIN;
  if (raw === "") return undefined;
  if (raw) return raw.replace(/\/$/, "");
  if (process.env.GRANTTAP_SKIP_WEBSITE === "1" || process.env.NODE_TEST_CONTEXT) return undefined;
  return "https://granttap.com";
}
