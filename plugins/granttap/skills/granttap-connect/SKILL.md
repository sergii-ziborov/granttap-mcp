---
name: granttap-connect
description: The agent connects this computer to GrantTap. Use when work needs pairing or the user asks to connect, pair, or repair.
---

# GrantTap connect

The person does not pair in chat. You connect this computer by calling tools.
This is the same on Cursor, Codex, and Claude Code.

## Chat (you)

1. Call `connection_status`.
2. If this computer is not paired, call `connect`.
3. If the host asks to authorize the MCP client, complete that host flow. Do
   not send the person to a website or ask them to scan in this chat.
4. Never print a pairing URI, manual token, or QR in chat.

A saved pairing is reused. Do not call `reconnect` unless they confirmed
Add another device or Reconnect in that host's GrantTap plugin settings.

## Settings (the person)

Device list, Add another device, and Reconnect live in GrantTap plugin
settings — Cursor Configure, Codex plugin settings, Claude Code plugin
settings — and in the GrantTap app. All three hosts on this computer share
the same pairing room.

For an interactive question, send the same complete prompt to the coding app
and GrantTap under one exact correlation. The first answer with that
correlation wins.
