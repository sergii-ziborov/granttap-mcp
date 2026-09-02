import assert from "node:assert/strict";
import test from "node:test";
import {
  attributedAgentResource,
  clearAgentLoad,
  recordAgentLoad,
} from "../apps/bridge/src/machine-load/agent-load-history";

const START = 1_800_000_000_000;

function sample(at: number, cpuPercent: number, memoryBytes: number): void {
  recordAgentLoad({ claude: { processes: 2, cpuPercent, memoryBytes } }, at);
}

test("a built-in call is costed from the samples taken while it ran", (t) => {
  t.after(clearAgentLoad);
  clearAgentLoad();
  // Two samples across a ten second call, at 50% and 100% of one core.
  sample(START + 2_000, 50, 100_000_000);
  sample(START + 8_000, 100, 300_000_000);

  const resource = attributedAgentResource("claude", START, START + 10_000);
  assert.equal(resource?.attribution, "attributed");
  // Each sample stands for half the call: 5s at 50% plus 5s at 100%.
  assert.equal(resource?.cpuTimeMs, 7_500);
  // Memory is a level, so the largest is what the call reached.
  assert.equal(resource?.peakRssBytes, 300_000_000);
  assert.equal(resource?.processCount, 2);
});

test("a call nothing was sampled near reports nothing", (t) => {
  t.after(clearAgentLoad);
  clearAgentLoad();
  sample(START, 80, 100_000_000);
  // Hours later: those samples describe a different moment entirely.
  assert.equal(
    attributedAgentResource("claude", START + 3_600_000, START + 3_610_000), undefined
  );
  // An agent that was never sampled has nothing to say.
  assert.equal(attributedAgentResource("codex", START, START + 1_000), undefined);
  // Nothing sampled at all.
  clearAgentLoad();
  assert.equal(attributedAgentResource("claude", START, START + 1_000), undefined);
});

test("a call with no duration is not costed", (t) => {
  t.after(clearAgentLoad);
  clearAgentLoad();
  sample(START, 90, 100_000_000);
  // Zero and negative spans would divide the machine's cost by nothing.
  assert.equal(attributedAgentResource("claude", START, START), undefined);
  assert.equal(attributedAgentResource("claude", START + 10, START), undefined);
});

test("an idle agent reports its memory without inventing cpu time", (t) => {
  t.after(clearAgentLoad);
  clearAgentLoad();
  sample(START + 1_000, 0, 250_000_000);
  const resource = attributedAgentResource("claude", START, START + 2_000);
  assert.equal(resource?.cpuTimeMs, undefined, "no cpu was spent, so none is claimed");
  assert.equal(resource?.peakRssBytes, 250_000_000);
});

test("the history stays bounded so a long session cannot grow without end", (t) => {
  t.after(clearAgentLoad);
  clearAgentLoad();
  for (let index = 0; index < 400; index += 1) sample(START + index * 30_000, 10, 1_000);
  // The oldest samples fall out; the newest still answer for a recent call.
  const late = START + 399 * 30_000;
  assert.ok(attributedAgentResource("claude", late - 10_000, late) != null);
  assert.equal(attributedAgentResource("claude", START, START + 10_000), undefined);
});
