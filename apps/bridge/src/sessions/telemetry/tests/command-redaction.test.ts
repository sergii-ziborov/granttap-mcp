import assert from "node:assert/strict";
import test from "node:test";
import { commandTextFromInput, redactSecrets } from "../command-preview";

test("ordinary options remain readable in commands and recorded diff lines", () => {
  for (const command of [
    "xcodebuild -project GrantTap.xcodeproj -parallel-testing-enabled NO",
    "+xcodebuild -project GrantTap.xcodeproj \\\n+  -parallel-testing-enabled NO",
    "git diff -p HEAD",
    "ssh -p2222 host",
    "mkdir -p/repo/build",
  ]) {
    assert.equal(redactSecrets(command), command);
    assert.equal(commandTextFromInput(command), command.replace(/\s+/g, " ").trim());
  }
});

test("password options retain command context, including values resembling safe options", () => {
  for (const program of ["mysql", "mariadb", "mysqldump", "mysqladmin", "7z", "7zz", "sshpass"]) {
    for (const password of ["synthetic-secret", "roject", "'two words'"]) {
      const command = `${program} -u user -p${password}`;
      assert.equal(redactSecrets(command), `${program} -u user -p[REDACTED]`);
    }
  }
  assert.equal(redactSecrets("mysql -psecret; xcodebuild -project App.xcodeproj"),
    "mysql -p[REDACTED]; xcodebuild -project App.xcodeproj");
  assert.equal(redactSecrets("mysql --host='semi;colon' -pfirst -psecond"),
    "mysql --host='semi;colon' -p[REDACTED] -p[REDACTED]");
  assert.equal(redactSecrets("+mysql \\\n+  -psecret"), "+mysql \\\n+  -p[REDACTED]");
  assert.equal(redactSecrets("TOKEN=synthetic-secret xcodebuild -project App.xcodeproj"),
    "TOKEN=[REDACTED] xcodebuild -project App.xcodeproj");
  assert.equal(redactSecrets("curl --password synthetic-secret https://example.test"),
    "curl --password [REDACTED] https://example.test");
});
