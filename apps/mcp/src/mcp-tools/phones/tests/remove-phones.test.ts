import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { phoneId, phoneRoster } from "../../../../../bridge/src/paired-phones";
import { recordControllerName, recordPhoneSeen } from "../../../../../bridge/src/pairing/presence";
import { isolatedConfig, live, NOW, pairedComputer } from "../../../../../bridge/src/paired-phones/tests/support";
import type { Consent } from "../removal";
import { removePhonesWithConsent, selectPhones } from "../removal";

type Structured = { status: string; removed: Array<{ id: string; name: string }>;
  kept: Array<{ id: string; reason: string }>; remaining: number };

function owner(t: TestContext, seen: Array<number | null>) {
  isolatedConfig(t);
  const f = pairedComputer(seen.length - 1, seen);
  const questions: string[] = [];
  const run = (selection: { phoneIds?: string[]; notSeenForDays?: number }, consent: (question: string) => Consent) =>
    removePhonesWithConsent(selection, { room: f.machine.room, computer: "QA MacBook", now: () => NOW,
      ask: async (question) => { questions.push(question); return consent(question); } });
  return { f, questions, run, id: phoneId };
}

const yes = (answeredBy?: string): Consent => ({ outcome: { status: "answered", decision: "yes" }, answeredBy });

test("an agent's removal waits for a yes on a phone and never takes the phone that answered", async (t) => {
  const { f, questions, run, id } = owner(t, [400, 0, null, 60, 45]);
  recordControllerName(f.extras[2]!, "Old iPad");
  const answer = await run({ notSeenForDays: 30 }, () => yes(f.primary));
  const result = answer.structuredContent as Structured;
  assert.equal(result.status, "removed");
  assert.deepEqual(result.removed.map((phone) => phone.id), f.extras.slice(1).map(id));
  assert.deepEqual(result.kept, [{ id: id(f.primary), label: id(f.primary).slice(0, 6), name: "iPhone",
    lastSeenAt: NOW - 400 * 86_400_000, reason: "the person answered on this phone" }]);
  assert.equal(result.remaining, 2);
  assert.deepEqual([live().peerPublicKey, ...live().extraPeerPublicKeys ?? []], [f.primary, f.extras[0]]);
  assert.match(questions[0]!, /^Remove 4 phones from QA MacBook\?/);
  assert.match(questions[0]!, /Old iPad · [a-f0-9]{6} · last seen 60 days ago/);
  assert.match(questions[0]!, /never seen/);
  assert.equal(questions[0]!.includes(f.extras[1]!), false, "the question names phones, never their keys");
});

test("a phone heard from while the question was open stays, even unnamed as the answer", async (t) => {
  const { f, run, id } = owner(t, [0, 90, 90]);
  const answer = await run({ phoneIds: [id(f.extras[0]!).slice(0, 6), id(f.extras[1]!)] }, () => {
    recordPhoneSeen(NOW + 1, f.extras[1]);
    return yes();
  });
  const result = answer.structuredContent as Structured;
  assert.deepEqual(result.removed.map((phone) => phone.id), [id(f.extras[0]!)]);
  assert.deepEqual(result.kept.map((phone) => phone.reason), ["it reached this computer while the question was open"]);
});

test("no, silence, nothing to remove and a selection of every phone remove nothing", async (t) => {
  const { f, questions, run, id } = owner(t, [0, 90]);
  const before = live();
  const no = await run({ notSeenForDays: 30 }, () => ({ outcome: { status: "answered", decision: "no" } }));
  assert.equal((no.structuredContent as Structured).status, "declined");
  const silent = await run({ notSeenForDays: 30 }, () => ({ outcome: { status: "timed_out", decision: null } }));
  assert.equal((silent.structuredContent as Structured).status, "timed_out");
  assert.match(silent.content[0]!.text, /not a yes/);
  const none = await run({ notSeenForDays: 365 }, () => yes());
  assert.equal((none.structuredContent as Structured).status, "nothing_to_remove");
  const every = await run({ phoneIds: [id(f.primary), id(f.extras[0]!)] }, () => yes());
  assert.equal(every.isError, true);
  assert.match(every.content[0]!.text, /leave at least one phone out/);
  assert.equal(questions.length, 2, "only the first two asked the person");
  assert.deepEqual(live(), before);
});

test("phone ids must name exactly one phone each", (t) => {
  const { f, id } = owner(t, [0, 90]);
  const roster = phoneRoster(live(), { now: NOW });
  assert.match((selectPhones(roster, {}, NOW) as { error: string }).error, /Name the phones/);
  assert.match((selectPhones(roster, { phoneIds: ["ffffff"] }, NOW) as { error: string }).error
    ?? "", /No phone/);
  const shared = id(f.primary).slice(0, 6) === id(f.extras[0]!).slice(0, 6);
  if (!shared) {
    assert.deepEqual((selectPhones(roster, { phoneIds: [id(f.extras[0]!).toUpperCase().slice(0, 8)] }, NOW) as
      { targets: Array<{ key: string }> }).targets.map((phone) => phone.key), [f.extras[0]]);
  }
  assert.deepEqual((selectPhones(roster, { phoneIds: [id(f.extras[0]!)], notSeenForDays: 365 }, NOW) as
    { targets: unknown[] }).targets, [], "both together take only phones matching both");
});
