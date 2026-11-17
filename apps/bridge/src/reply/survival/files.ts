/**
 * The files a survivable run reads and writes instead of pipes. A pipe closes with the monitor that
 * holds its other end, and a provider writing to it then fails; a file outlives the monitor, so the
 * run goes on and the next monitor reads what it wrote.
 */
import { closeSync, openSync, readSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { StringDecoder } from "node:string_decoder";

export type RunFiles = {
  stdio: [number | "ignore", number, number];
  stdoutPath: string;
  stderrPath: string;
  /** Close this process's copies of the descriptors and unlink the prompt once the child holds it open. */
  release: () => void;
};

export function openRunFiles(folder: string, stdin?: string): RunFiles {
  const stdoutPath = join(folder, "stdout"), stderrPath = join(folder, "stderr"), inputPath = join(folder, "stdin");
  const descriptors: number[] = [];
  let input: number | "ignore" = "ignore";
  try {
    if (stdin != null) {
      writeFileSync(inputPath, stdin, { mode: 0o600 });
      input = openSync(inputPath, "r");
      descriptors.push(input);
    }
    const out = openSync(stdoutPath, "a", 0o600);
    descriptors.push(out);
    const err = openSync(stderrPath, "a", 0o600);
    descriptors.push(err);
    return {
      stdio: [input, out, err], stdoutPath, stderrPath,
      release: () => {
        for (const fd of descriptors.splice(0)) { try { closeSync(fd); } catch { /* Already closed. */ } }
        if (stdin != null) { try { unlinkSync(inputPath); } catch { /* Already gone. */ } }
      },
    };
  } catch (error) {
    for (const fd of descriptors) { try { closeSync(fd); } catch { /* Already closed. */ } }
    throw error;
  }
}

/** Reads what a run appended to one of its files since the last read, whole characters only. */
export class FileTail {
  private offset = 0;
  private fd?: number;
  private readonly decoder = new StringDecoder("utf8");

  constructor(private readonly path: string) {}

  read(): string {
    try { this.fd ??= openSync(this.path, "r"); } catch { return ""; }
    let text = "";
    const chunk = Buffer.allocUnsafe(65_536);
    for (;;) {
      let read = 0;
      try { read = readSync(this.fd, chunk, 0, chunk.length, this.offset); } catch { break; }
      if (read <= 0) break;
      this.offset += read;
      text += this.decoder.write(chunk.subarray(0, read));
    }
    return text;
  }

  close(): void {
    if (this.fd === undefined) return;
    try { closeSync(this.fd); } catch { /* Already closed. */ }
    this.fd = undefined;
  }
}

/** Everything a run wrote to one file. */
export function readRunOutput(path: string): string {
  const tail = new FileTail(path);
  try { return tail.read(); } finally { tail.close(); }
}
