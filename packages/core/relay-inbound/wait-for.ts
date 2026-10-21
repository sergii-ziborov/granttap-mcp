import type { Payload } from "../../protocol/schema";

/** One bounded payload wait, cancelled by its own match or deadline. */
export function waitForRelayPayload<T extends Payload>(
  subscribe: (listener: (payload: Payload) => boolean | void) => () => void,
  predicate: (payload: Payload) => payload is T,
  timeoutMs: number,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { off(); reject(new Error("waitFor timeout")); }, timeoutMs);
    const off = subscribe(payload => {
      if (!predicate(payload)) return;
      clearTimeout(timer);
      off();
      resolve(payload);
      return true;
    });
  });
}
