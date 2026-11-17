/**
 * A Claude Desktop chat that illustrated a course, in the shapes its transcript and its Codex runs
 * really had (17 November 2026, 894 runs): it wrote prompts to a file, wrote `one.sh` that runs
 * `codex exec -C <folder>` per index, ran a pilot, ran the rest detached through `xargs`, then wrote
 * a Python batch that calls `subprocess.run(["codex", "exec", …])` and a Grok worker, and ran both
 * detached. No command after the pilot carries a request. Paths are this fixture's.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** Offsets from the first command, as the real chat ran them. */
export const AT = {
  prompts: 0, pilot: 39_639, detached: 133_985, nohup: 746_432, stopped: 1_386_897, batch: 1_627_692,
  grok: 5_034_218, last: 5_849_855,
} as const;

export const ONE_REQUEST = "Use your image_gen tool to generate exactly one landscape image and save it to";
export const BATCH_REQUEST = "Use your image_gen tool to generate 4 separate landscape images, one tool call per image, "
  + "and save each to the exact path given. Do not write code. After saving all of them, print the paths and stop.";

/** The commands, in order, with the folder they work in. */
export function lessonartCommands(folder: string): Array<{ at: number; command: string; background?: boolean; endsAfter: number }> {
  const F = folder;
  return [
    { at: AT.prompts, endsAfter: 900, command: `mkdir -p ${F} && cd /Users/me/dev/lessons && node -e "
const fs=require('fs');
const L=JSON.parse(fs.readFileSync('content/learning/review-diagrams.json','utf8'));
fs.writeFileSync('${F}/jobs.json',JSON.stringify(L.map(l=>({id:l.id,title:l.title})),null,1));
console.log('jobs',L.length);"` },
    { at: AT.pilot, endsAfter: 80_224, command: `cat > ${F}/one.sh <<'SH'
#!/usr/bin/env bash
# one.sh <index> : generate prompts.json[index] into ${F}/png/<file>.png
i="$1"; mkdir -p ${F}/png ${F}/log
file=$(python3 -c "import json;print(json.load(open('${F}/prompts.json'))[$i]['file'])")
out="${F}/png/\${file%.webp}.png"
[ -s "$out" ] && exit 0
prompt=$(python3 -c "import json;print(json.load(open('${F}/prompts.json'))[$i]['prompt'])")
timeout 600 codex exec --skip-git-repo-check --sandbox workspace-write -C ${F} \\
  "${ONE_REQUEST} $out. Prompt: $prompt Do not write code. Call the image tool, save the file, print the path, stop." \\
  < /dev/null > "${F}/log/\${file%.webp}.log" 2>&1
[ -s "$out" ] && echo "OK $file" || echo "FAIL $file"
SH
chmod +x ${F}/one.sh
time (seq 0 5 | xargs -P 6 -I{} ${F}/one.sh {})` },
    { at: AT.detached, endsAfter: 600_000, background: true, command: `cd ${F} && python3 - <<'PY'
import json
p = json.load(open("prompts.json"))
for x in p:
    x["prompt"] += " Avoid stock visual clichés."
json.dump(p, open("prompts.json", "w"), indent=1)
PY
rm -f ${F}/png/*.png && echo "pilot cleared; launching 437"
seq 0 436 | xargs -P 6 -I{} ${F}/one.sh {} > ${F}/run.log 2>&1; echo "=== finished ==="` },
    { at: AT.nohup, endsAfter: 2_500, command: `cd ${F} && nohup bash -c 'seq 0 436 | xargs -P 6 -I{} ${F}/one.sh {} >> ${F}/run.log 2>&1; echo DONE >> ${F}/run.log' > /dev/null 2>&1 & disown; sleep 2; pgrep -f "codex exec" | wc -l` },
    { at: AT.stopped, endsAfter: 2_300, command: `pkill -f "${F}/one.sh"; pkill -f "codex exec --skip-git-repo-check --sandbox workspace-write -C ${F}"; sleep 2; ls ${F}/png | wc -l; date` },
    { at: AT.batch, endsAfter: 2_500, command: `mkdir -p ${F}/png ${F}/log && cat > ${F}/batch.py <<'PY'
#!/usr/bin/env python3
"""batch.py <start> <end>: generate missing queue[start:end] PNGs in one Codex run. Exit 3 on usage limit."""
import json, os, subprocess, sys
Q = json.load(open("${F}/queue.json"))
s, e = int(sys.argv[1]), int(sys.argv[2])
todo = [q for q in Q[s:e] if not os.path.exists("${F}/" + q["png"])]
lines = "\\n\\n".join(f"Image {i+1}: save to ${F}/{q['png']}\\nPrompt: {q['prompt']}" for i, q in enumerate(todo))
prompt = (f"Use your image_gen tool to generate {len(todo)} separate landscape images, one tool call per image, "
          f"and save each to the exact path given. Do not write code. After saving all of them, print the paths and stop.\\n\\n{lines}")
log = f"${F}/log/batch-{s:04d}.log"
with open(log, "w") as fh:
    subprocess.run(["timeout", "1500", "codex", "exec", "-c", 'model_reasoning_effort="low"', "--skip-git-repo-check",
                    "--sandbox", "workspace-write", "-C", "${F}", prompt], stdin=subprocess.DEVNULL, stdout=fh, stderr=subprocess.STDOUT)
if "usage limit" in open(log).read(): sys.exit(3)
PY
cat > ${F}/runner.sh <<'SH'
#!/usr/bin/env bash
cd ${F}
seq 0 4 507 | xargs -P 3 -I{} sh -c 'python3 ${F}/batch.py {} $(({}+4)) || touch ${F}/limit.flag'
SH
chmod +x ${F}/runner.sh ${F}/batch.py` },
    { at: AT.grok, endsAfter: 6_300, command: `cat > ${F}/grok_one.py <<'PY'
#!/usr/bin/env python3
import json, os, subprocess, sys
q = json.load(open("${F}/queue.json"))[int(sys.argv[1])]
out = "${F}/" + q["png"]
with open(f"${F}/log/grok-{os.path.basename(q['png'])}.log", "w") as fh:
    subprocess.run(["timeout", "600", "grok", "--cwd", "${F}", "--always-approve", "--max-turns", "6", "-p",
                    f"Use your GenerateImage tool to create exactly one landscape image, then save it as PNG at {out}. Prompt: {q['prompt']}"],
                   stdin=subprocess.DEVNULL, stdout=fh, stderr=subprocess.STDOUT)
PY
chmod +x ${F}/grok_one.py && cd ${F} && nohup sh -c 'seq 507 -1 0 | xargs -P 4 -I{} python3 ${F}/grok_one.py {} >> ${F}/grok.log 2>&1' > /dev/null 2>&1 &
nohup ${F}/runner.sh > ${F}/runner.out 2>&1 &
sleep 3; echo "grok workers: $(pgrep -f grok_one.py | wc -l)"` },
    { at: AT.last, endsAfter: 1_900, command: `ls ${F}/png | wc -l; tail -3 ${F}/status.log` },
  ];
}

const iso = (at: number) => new Date(at).toISOString();

/** The chat's transcript rows: each command, its result, and for the one sent to the background, its notification. */
export function lessonartRows(folder: string, start: number, sessionId: string, cwd = "/Users/me/dev/lessons"): object[] {
  const base = { sessionId, cwd, entrypoint: "claude-desktop" };
  const rows: object[] = [{ ...base, type: "user", timestamp: iso(start - 3_600_000),
    message: { role: "user", content: "Illustrate every lesson of the course" } }];
  lessonartCommands(folder).forEach(({ at, command, background, endsAfter }, index) => {
    const id = `toolu_lessonart_${index}`;
    rows.push({ ...base, type: "assistant", timestamp: iso(start + at), message: { role: "assistant", content: [
      { type: "tool_use", id, name: "Bash", input: { command, ...(background ? { run_in_background: true } : {}) } }] } });
    rows.push({ ...base, type: "user", timestamp: iso(start + at + (background ? 400 : endsAfter)),
      ...(background ? { toolUseResult: { backgroundTaskId: `bg${index}task` } } : {}),
      message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, content: "ok" }] } });
    if (background) {
      rows.push({ ...base, type: "user", timestamp: iso(start + at + endsAfter),
        message: { role: "user", content: `<task-notification><tool-use-id>${id}</tool-use-id><status>killed</status></task-notification>` } });
    }
  });
  rows.push({ ...base, type: "assistant", timestamp: iso(start + AT.last + 2_000), message: { role: "assistant",
    stop_reason: "end_turn", content: [{ type: "text", text: "The runners go on by themselves." }] } });
  return rows;
}

export function writeTranscript(path: string, rows: readonly object[]): void {
  writeFileSync(path, rows.map((row) => JSON.stringify(row)).join("\n") + "\n");
}

/** A `codex exec` run's rollout, as Codex writes it under its sessions folder by day. */
export function writeCodexRun(root: string, input: { id: string; at: number; cwd: string; request: string;
  headless?: boolean; seconds?: number }): void {
  const day = join(root, ...iso(input.at).slice(0, 10).split("-"));
  mkdirSync(day, { recursive: true });
  const end = input.at + (input.seconds ?? 60) * 1_000;
  const meta = input.headless === false ? { originator: "codex_cli_rs", source: "cli" } : { originator: "codex_exec", source: "exec" };
  writeTranscript(join(day, `rollout-${iso(input.at).slice(0, 19).replace(/:/g, "-")}-${input.id}.jsonl`), [
    { type: "session_meta", timestamp: iso(input.at), payload: { id: input.id, timestamp: iso(input.at), cwd: input.cwd, ...meta } },
    { type: "response_item", timestamp: iso(input.at + 600), payload: { type: "message", role: "user", content: [
      { type: "input_text", text: `<environment_context>\n  <cwd>${input.cwd}</cwd>\n</environment_context>` },
      { type: "input_text", text: input.request }] } },
    { type: "response_item", timestamp: iso(end - 100), payload: { type: "message", role: "assistant", content: [
      { type: "output_text", text: "Saved the picture." }] } },
    { type: "event_msg", timestamp: iso(end), payload: { type: "task_complete" } },
  ]);
}
