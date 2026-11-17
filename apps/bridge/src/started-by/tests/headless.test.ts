import assert from "node:assert/strict";
import test from "node:test";
import { headlessRun, headlessTargets, lineageText, promptLead, PROMPT_LEAD_CHARS } from "../headless";

test("a provider process started headless is told from an interactive one and from a resumed chat", () => {
  assert.deepEqual(headlessRun("codex", "node /opt/homebrew/bin/codex exec Use your image_gen tool"),
    { headless: true, resume: false, folder: undefined });
  assert.equal(headlessRun("codex", "/usr/local/bin/codex -m gpt-5 -c x=1 exec --json draw a lighthouse").headless, true,
    "options and their values come before the subcommand");
  assert.equal(headlessRun("codex", "/usr/local/bin/codex e quick request").headless, true);
  assert.deepEqual(headlessRun("codex", "codex exec resume --last"), { headless: true, resume: true, folder: undefined });
  assert.equal(headlessRun("codex", "/usr/local/bin/codex").headless, false, "the terminal UI is a person's chat");
  assert.equal(headlessRun("codex", "/usr/local/bin/codex --model exec").headless, false, "a flag's value is no subcommand");
  assert.equal(headlessRun("codex", "codex exec -C /tmp/blogart draw").folder, "/tmp/blogart");
  assert.equal(headlessRun("codex", "codex exec -C relative draw").folder, undefined);

  assert.deepEqual(headlessRun("claude", "/Users/me/.local/bin/claude -p --output-format json write a haiku"),
    { headless: true, resume: false, folder: undefined });
  assert.equal(headlessRun("claude", "claude --print=hello").headless, true);
  assert.equal(headlessRun("claude", "node /usr/lib/claude.js --input-format stream-json --output-format stream-json").headless, true,
    "the SDK talks to Claude over stream-json without -p");
  assert.equal(headlessRun("claude", "claude -p --resume 38034755-03a1-429d-8db6-2aa351e64a0b next").resume, true,
    "a phone message to an existing chat resumes it");
  assert.equal(headlessRun("claude", "/Users/me/Library/Application Support/Claude/claude-code/2.1/claude").headless, false);
  assert.equal(headlessRun("claude", "claude -p --session-id 11111111-2222-3333-4444-555555555555 hi").sessionId,
    "11111111-2222-3333-4444-555555555555");
  assert.equal(headlessRun("claude", "claude -p --session-id bad hi").sessionId, undefined);
  assert.deepEqual(headlessRun("grok", "grok --no-auto-update --cwd /tmp/run --session-id abcdefgh-1 -p draw --output-format streaming-json"),
    { headless: true, resume: false, sessionId: "abcdefgh-1", folder: "/tmp/run" });
  assert.equal(headlessRun("grok", "grok --resume abcdefgh-1 -p next").resume, true);
  assert.equal(headlessRun("claude", "/usr/bin/vim notes.md").headless, false, "a line that is not the provider's says nothing");
});

test("a shell command names the providers it starts headless, and only by their own word", () => {
  assert.deepEqual(headlessTargets(`cd /tmp/blogart && codex exec "Use your image_gen tool to make a hero -p image"`), ["codex"]);
  assert.deepEqual(headlessTargets(`for p in a b; do /opt/homebrew/bin/codex exec "$p" & done; wait`), ["codex"]);
  assert.deepEqual(headlessTargets(`claude -p "summarise -r this" | tee out.txt`), ["claude"],
    "a flag inside the quoted request is part of the request");
  assert.deepEqual(headlessTargets(`OUT=$(grok -p 'draw a map' --output-format json)`), ["grok"]);
  assert.deepEqual(headlessTargets(`ls ~/.claude/projects && cat ~/.codex/config.toml`), [], "a folder named after a provider starts nothing");
  assert.deepEqual(headlessTargets(`codex exec resume --last`), [], "a resumed run is not a new chat");
  assert.deepEqual(headlessTargets(`claude --version; codex --help`), []);
  assert.deepEqual(headlessTargets(`"/Users/me/Application Support/codex" exec "draw"`), [],
    "a quoted path with a space reads as one word, which keeps the match conservative");
});

test("a request and the command that carried it compare in one spelling", () => {
  const prompt = `Use your image_gen tool to generate a "calm" hero image\nfor the article: don't add text.`;
  const command = `codex exec "Use your image_gen tool to generate a \\"calm\\" hero image\nfor the article: don'\\''t add text."`;
  assert.ok(lineageText(command).includes(lineageText(prompt)));
  assert.equal(lineageText("a\\nb  \t c"), "a b c");
  const lead = promptLead(`${"word ".repeat(30)}end`)!;
  assert.equal(lead.lead.length, PROMPT_LEAD_CHARS);
  assert.equal(lead.length, 153);
  assert.equal(promptLead("Draw a cat"), undefined, "a short request says too little to be matched");
  assert.equal(promptLead(undefined), undefined);
});
