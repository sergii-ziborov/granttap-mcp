/**
 * Diagnostics may never end the process that writes them.
 *
 * Desktop clients redirect an MCP server's stderr into a log file. When that
 * disk fills, a write fails with ENOSPC and the stream emits `error`; with no
 * listener Node turns it into an uncaught exception and the server disconnects
 * mid-session. Losing the log line is the right trade.
 */
export function keepDiagnosticsNonFatal(stream: NodeJS.WriteStream | NodeJS.WritableStream = process.stderr): void {
  stream.on("error", () => {});
}
