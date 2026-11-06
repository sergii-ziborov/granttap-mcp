# Isolated App Review MCP computer

Internal deployment fixture, excluded from the public npm package. This consumes
the existing GrantTap MCP relay, approval, open-question, monitor and account
recovery implementations. It adds no coding provider or alternate runtime.

An operator enrolls a separate computer through the dedicated review account's
normal password and machine APIs, then mounts only that computer's private
configuration at `/data/granttap`. No personal project, provider login, shell tool,
or developer computer configuration belongs in this container. The process sends
explicitly labelled synthetic Yes/No and text questions through normal encrypted
MCP delivery. It never pretends to run Claude, Codex, an AI model, or a command.

The walkthrough retains only its numeric phase and timestamp. Normal MCP
approval state retains the normal receipt lifecycle. Private answers are never
printed or copied into walkthrough state. After both replies it pauses ten
minutes before offering another cycle. Silence does not advance progress.
Account recovery adds each approved device's own key; no shared reviewer secret
is exposed in a URL or web page. Managed admission and controller revocation stay
enforced by the existing runtime.

Run `node --import tsx --test integration/AppReviewComputer/tests/*.test.ts`.
Tests exchange actual encrypted WebSocket questions and replies, verify durable
progress across calls, and prove unanswered steps do not advance. The service
health endpoint reports relay connectivity, not provider execution or AI usage.
