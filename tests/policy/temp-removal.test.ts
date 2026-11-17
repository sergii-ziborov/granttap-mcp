import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { guessRisk } from "../../apps/bridge/src/host/adapters";
import { classifyAction, shouldAutoAllow } from "../../apps/bridge/src/policy";
import { removesOnlyTempPaths } from "../../apps/bridge/src/policy/shell/temp-removal";

function scratch(): string {
  const root = mkdtempSync("/tmp/granttap-rm-");
  mkdirSync(join(root, "shots"));
  return root;
}

test("removing a chat's scratch folder under /tmp is ordinary work, as the owner's xcresult cleanup", () => {
  const root = scratch();
  try {
    const command = `rm -rf ${root}/shots/elk.xcresult; UDID=$(cat ${root}/udid); cd /Users/x/project && `
      + `xcrun xcresulttool export attachments --path ${root}/elk.xcresult >/dev/null 2>&1; ls ${root} | head -40`;
    assert.equal(removesOnlyTempPaths(command), true);
    assert.equal(classifyAction("Bash", command), "bash");
    assert.equal(shouldAutoAllow("except_push", classifyAction("Bash", command)), true);
    assert.equal(guessRisk("Bash", command), "medium");
    for (const flags of ["-rf", "-fr", "-R -f", "-r", "-rfv"]) {
      assert.equal(removesOnlyTempPaths(`rm ${flags} ${root}/shots`), true, flags);
    }
    assert.equal(removesOnlyTempPaths(`rm -rf -- '${root}/shots' && /bin/rm -rf ${root}/a`), true);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("any removal that is not a literal path below a temp root still asks", () => {
  const root = scratch();
  const link = join(root, "home-link");
  // The test runner puts HOME in a temp folder, so the link leads to this checkout instead.
  symlinkSync(process.cwd(), link);
  try {
    for (const command of [
      "rm -rf build", "rm -rf ~/tmp", "rm -rf /tmp", "rm -rf /tmp/", "rm -rf /private/tmp", `rm -rf ${root}/`,
      `rm -rf ${root}/../x`, `rm -rf ${root}/./`, `rm -rf ${root}/*`, `rm -rf $TMPDIR/x`, `rm -rf "${root}/x"`,
      `rm -rf ${root}/x /Users/x/project`, `rm -rf ${root}/shots; rm -rf /Users/x/project`,
      `find ${root} -name x | xargs rm -rf`, `git rm -rf ${root}/x`, `rm -rf ${link}/apps`,
      `rm -i ${root}/x`, "rm -rf", `rm -rf /tmp/does-not-exist-${Date.now()}/x`, `rm -rf ${root}/x 2>/dev/null`,
    ]) {
      assert.equal(removesOnlyTempPaths(command), false, command);
      assert.equal(classifyAction("Bash", command), command === "rm -i " + `${root}/x` ? "bash" : "destructive", command);
    }
    assert.equal(classifyAction("Bash", `sudo rm -rf ${root}/shots`), "destructive");
    assert.equal(guessRisk("Bash", "rm -rf /Users/x/project"), "high");
  } finally { rmSync(root, { recursive: true, force: true }); }
});
