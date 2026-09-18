---
name: granttap-connect
description: The agent connects this computer to GrantTap. Use when work needs pairing or the user asks to connect, pair, or repair.
---

# GrantTap connect

The person does not pair in chat. You connect this computer by calling tools.

## Chat (you)

1. Call `connection_status`.
2. If this computer is not paired, call `connect`.
3. Never print a pairing URI, manual token, or QR in chat.
4. Never tell the person to scan something in this conversation, open a website,
   or type a setup command.

A saved pairing is reused. Do not call `reconnect` unless they confirmed
Add another device or Reconnect in plugin settings.

## Settings (the person)

Device list, Add another device, and Reconnect live in the GrantTap plugin
settings of this host — Cursor Configure, Codex plugin settings, Claude Code
plugin settings — and in the GrantTap app. The same pairing room is shared
across those hosts on this computer.

For an interactive question, send the same complete prompt to Cursor and
GrantTap under one exact correlation. The first answer with that correlation
wins.
