import { execFileSync } from "node:child_process";
import { hostname } from "node:os";

type NameSources = {
  platform?: NodeJS.Platform;
  host?: string;
  override?: string;
  macName?: () => string;
};

function usableName(value: string | undefined): string | null {
  const name = value?.trim();
  return name && name.length <= 80 && !/[\x00-\x1f\x7f]/.test(name) ? name : null;
}

/** User-visible computer name; network hostname remains only a fallback. */
export function computerDisplayName(sources: NameSources = {}): string {
  const override = usableName(sources.override ?? process.env.GRANTTAP_COMPUTER_NAME);
  if (override) return override;
  if ((sources.platform ?? process.platform) === "darwin") {
    try {
      const macName = sources.macName ?? (() => execFileSync(
        "/usr/sbin/scutil", ["--get", "ComputerName"],
        { encoding: "utf8", timeout: 2_000, maxBuffer: 4_096 },
      ));
      const name = usableName(macName());
      if (name) return name;
    } catch { /* Computer Name may be unset; preserve the network fallback. */ }
  }
  return usableName(sources.host ?? hostname()) ?? "Computer";
}
