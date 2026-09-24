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
4. Never put a private pairing QR in this conversation. If the host cannot
   call tools from the connection card, explain the local interactive-terminal
   fallback: `granttap phone add` or `granttap phone reconnect`.

A saved pairing is reused. Do not call `reconnect` unless they confirmed
Add another device or Reconnect in plugin settings.

## Settings (the person)

The GrantTap connection card in this host shows the device list and one-time
QR under Add a device, Add another device, or Reconnect when the host supports
interactive MCP Apps. GrantTap on iPhone scans it in Settings → Connections.
granttap.com/connect handles coding-app approval and phone observations, but
does not display a pairing QR. All coding apps on this computer share one room.

For an interactive question, send the same complete prompt to Cursor and
GrantTap under one exact correlation. The first answer with that correlation
wins.
