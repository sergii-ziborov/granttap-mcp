# Grok response admission

[`index.ts`](index.ts) reads Grok Build's `streaming-json` response contract.
Actual text, thinking, or a started tool call confirms that the prompt reached
execution. Startup metadata alone does not establish admission. Native error
messages remain failures and metadata is never returned as answer text.

Opening a session has a 60-second response-activity deadline, separate from the
long execution budget. A stalled opening stops only the process group GrantTap
started and asks the person to inspect the native task before retrying. Once
response activity is witnessed, a later timeout or run failure cannot rewrite
the accepted message as a rejected delivery. Execution failure still reaches
the chat. This does not grant tools, authenticate MCP, or alter Grok policy.

Behavior tests live in `../tests/grok-response.test.ts` and
`../tests/admission-deadline.test.ts`; durable receipt tests live in
`../../monitor/message-delivery/tests/run-outcome.test.ts`.

License: this module is distributed under the GrantTap Commercial Source License
in the repository-root `LICENSE` file.
