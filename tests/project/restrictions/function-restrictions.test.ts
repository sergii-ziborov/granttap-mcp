import assert from "node:assert/strict";
import test from "node:test";
import { evaluateContent, functionLineCounts } from "../../../apps/bridge/src/mesh/restrictions";

test("function line counts measure brace-depth bodies", () => {
  const source = [
    "function small() {",
    "  return 1;",
    "}",
    "function big() {",
    ...Array.from({ length: 8 }, () => "  void 0;"),
    "}",
  ].join("\n");
  assert.deepEqual(functionLineCounts(source), [3, 10]);
  const hit = evaluateContent([{
    ruleId: "max-function-lines", kind: "max_function_lines", limit: 5, effect: "deny",
  }], "src/fn.ts", source);
  assert.match(hit?.reason ?? "", /10 lines/);
});

test("unparsed function forms request review instead of passing the limit", () => {
  const rule = [{
    ruleId: "function-lines", kind: "max_function_lines" as const,
    limit: 4, effect: "deny" as const,
  }];
  const arrow = ["const work = () => {", ...Array(8).fill("  run();"), "};"].join("\n");
  const method = ["class Worker {", "  work() {", ...Array(8).fill("    run();"), "  }", "}"].join("\n");
  const python = ["def work():", ...Array(8).fill("    run()")].join("\n");
  assert.equal(evaluateContent(rule, "src/work.ts", arrow)?.effect, "ask");
  assert.equal(evaluateContent(rule, "src/work.ts", method)?.effect, "ask");
  assert.equal(evaluateContent(rule, "src/work.py", python)?.effect, "ask");
  assert.equal(evaluateContent(rule, "src/work.ts", "if (ready) { run(); }")?.effect, undefined);
});
