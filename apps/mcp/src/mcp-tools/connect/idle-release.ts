/**
 * Every Claude Desktop, Cursor or Codex session runs its own GrantTap MCP, and each kept a relay
 * socket open for good under the computer's identity. The relay allows a computer only so many
 * connections, so a dozen idle sessions left the monitor, which carries the phone's messages, no
 * place. A session's link now closes after it goes unused, unless this process is the one leading
 * the computer's monitoring because no separate monitor runs.
 */
export function createIdleRelease(options: {
  idleMs: number;
  isLeader: () => boolean;
  release: () => void;
}): { touch: () => void; cancel: () => void } {
  let timer: NodeJS.Timeout | undefined;
  const cancel = () => { if (timer) clearTimeout(timer); timer = undefined; };
  const touch = () => {
    cancel();
    timer = setTimeout(() => {
      timer = undefined;
      if (options.isLeader()) { touch(); return; }
      options.release();
    }, options.idleMs);
    timer.unref?.();
  };
  return { touch, cancel };
}
