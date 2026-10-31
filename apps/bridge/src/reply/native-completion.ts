import {createHash} from 'node:crypto';
import type {ReplyResult} from './payload/types';

export const nativePromptDigest = (text: string) => createHash('sha256').update(text).digest('hex');
export type NativeCompletionProof = {nativeSessionId: string; promptAt: number; completedAt: number;
  promptDigests: string[]; text: string};
type Run = {key: string; startedAt: number; nativeId?: string; digest?: string;
  resolve: (result: ReplyResult) => void; result: Promise<ReplyResult>; completed: boolean};

/** Match this invocation's exact native prompt before releasing its confirmed final answer. */
export class NativeTurnCompletions {
  private readonly runs = new Map<string, Run>();
  constructor(private readonly now = Date.now) {}
  begin(key: string) {
    let resolve!: Run['resolve'];
    const result = new Promise<ReplyResult>(done => {resolve = done});
    const run: Run = {key, startedAt: this.now(), resolve, result, completed: false};
    this.runs.set(key, run);
    return {result, close: () => {if (this.runs.get(key) === run) this.runs.delete(key)}};
  }
  bind(nativeId: string, prompt: string, nativeForKey: (key: string) => string) {
    const run = [...this.runs.values()].find(item => !item.nativeId && nativeForKey(item.key) === nativeId);
    if (run) {run.nativeId = nativeId; run.digest = nativePromptDigest(prompt)}
  }
  complete(key: string, proof: NativeCompletionProof): boolean {
    const run = this.runs.get(key);
    if (!run || run.completed || run.nativeId !== proof.nativeSessionId || !run.digest
        || !proof.promptDigests.includes(run.digest) || proof.promptAt < run.startedAt
        || proof.completedAt < proof.promptAt || proof.completedAt > this.now() + 5_000
        || !proof.text.trim()) return false;
    run.completed = true;
    run.resolve({ok: true, text: proof.text, delivery: 'native'});
    return true;
  }
}
