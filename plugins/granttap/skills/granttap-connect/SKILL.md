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

If the host cannot call tools from the connection card, tell the person to run
`granttap phone add` in their own interactive terminal, or `granttap phone
reconnect` for the same phone. These commands refuse redirected output so the
QR cannot enter agent logs.

A saved pairing is reused. Do not call `reconnect` unless they confirmed
Add another device or Reconnect in that host's GrantTap plugin settings.

## Settings (the person)

Codex Connected accounts lists external app accounts, not GrantTap phones.
The GrantTap connection card in the coding app shows the device list and the
one-time QR under Add a device, Add another device, or Reconnect. The iPhone app
scans it under Settings → Connections → Add a device (Scan QR). For a second
controller, the already paired iPhone can show its own QR in Settings. The
granttap.com/connect page handles coding-app approval and observations; it does
not generate a QR. All coding apps on this computer share the same pairing room.

For an interactive question, send the same complete prompt to the coding app
and GrantTap under one exact correlation. The first answer with that
correlation wins.
