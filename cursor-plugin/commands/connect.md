---
description: Connect or reconnect GrantTap phone dual-channel approvals
---

Invoke the **granttap-connect** skill (`skills/connect/SKILL.md`) and follow it end-to-end.

Goal: pair this Cursor session with GrantTap so every interactive prompt reaches **both** Cursor chat and the phone with identical text, and either channel’s answer is enough.

1. Ensure GrantTap **HTTP** MCP is available at `http://127.0.0.1:17342/mcp` (`granttap-mcp serve`). Authorize requires HTTP — never stdio in plugin `mcp.json`.
2. Call MCP `connect` (QR / pairing in chat). CLI fallback: `npx -y granttap-mcp@latest connect`.
3. Call MCP `setup` when hooks/helper/HTTP LaunchAgent/local plugin are missing. CLI fallback: `npx -y granttap-mcp@latest setup`.
4. Use `notify` for status; verify dual-channel before declaring success.

Do not gut the phone app or strip in-chat product UI. Prefer the stable JS MCP; Rust may come later.
