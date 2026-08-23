# Cursor Beta setup

The normal path is one command:

```bash
granttap setup
```

When Cursor is installed, setup preserves unrelated MCP entries, installs the
GrantTap shell and MCP policy hooks, configures the loopback HTTP MCP endpoint,
and installs its persistent per-user service. Then open **Cursor Settings → MCP
→ GrantTap → Authorize** to complete Cursor's browser consent.

The service binds only to loopback. Its OAuth token does not replace GrantTap's
end-to-end encrypted computer pairing.

If the Cursor integration later needs repair, run:

```bash
granttap cursor repair
```

Do not edit `mcp.json` in the normal path. GrantTap backs up the existing file
before changing only its own entry.
