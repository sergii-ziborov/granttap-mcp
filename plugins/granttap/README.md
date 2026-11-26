# GrantTap for Codex, Claude Code, Cursor, and Grok Build

![GrantTap](assets/logo.png)

Approve, answer and steer your coding agents from iPhone, iPad and Apple Watch.
GrantTap for iPhone and iPad is a free download on the
[App Store](https://apps.apple.com/app/id6809739366); Apple Watch is a companion
to the iPhone app, and GrantTap for Mac is in TestFlight until Apple approves it.

<a href="https://apps.apple.com/app/id6809739366"><img src="https://toolbox.marketingtools.apple.com/api/v2/badges/download-on-the-app-store/black/en-us" alt="Download GrantTap on the App Store" height="40"></a>

GrantTap links local coding agents to an Account Mesh that can hold many
computers and Project Meshes. Each Task uses its selected computer route while
you approve requests, answer questions, inspect work, and steer tasks from
iPhone, iPad, Mac, or Apple Watch. An account can exist before any computer is
connected.

## Install from the GrantTap marketplace

### Codex

Install the durable local GrantTap helper on each Mac or Windows computer you connect:

```bash
npm install --global granttap-mcp
granttap setup
```

Install or update the plugin from the public GitHub marketplace:

```bash
codex plugin marketplace add sergii-ziborov/granttap-mcp
codex plugin add granttap@granttap
```

Codex **Connected accounts** does not list GrantTap phones. On the plugin page, click **Try now →
Connect GrantTap to this computer** to open its connection card in a conversation.
On a new computer, the card offers **Sign in**: confirm with your GrantTap
passkey on granttap.com, then open GrantTap on your iPhone signed in to the same
account, and it links this computer by itself, without a QR. If GrantTap later
signs this computer out, the card says so and offers **Sign in again**. The
passkey check keeps the existing QR room unchanged; repeating it reuses the
computer's machine identity and updates its user-assigned display name. The QR
is the fallback: the card shows one under **Add a device** (in the GrantTap
iPhone app, **Devices → Add a device → Scan QR**); for another iPhone or iPad,
choose **Add another device**; for the same phone after reinstall, **Reconnect**.
A saved computer pairing does not automatically put a phone in Codex's account
list. If a coding app cannot operate the card, run `granttap sign-in` in your
own terminal; for the QR, `granttap phone add`, or `granttap phone reconnect`
for the same phone. These commands refuse to print a private QR into redirected
output or agent logs.

`codex mcp login granttap` authorizes Codex as an MCP client. Its browser page
at `granttap.com/connect` offers approval through a fresh GrantTap account
passkey on the Mac, or through the existing phone/QR flow. Passkey approval
authorizes this coding app to use this computer's local MCP and also signs this
computer in to that GrantTap account, so a phone signed in to it links this
computer without a QR.
The page also shows phone observations;
the connection card shows the pairing QR. The website does not receive pairing
keys or task content. Provider sign-in remains separate. Never paste a pairing
token or QR into chat. A Git marketplace plugin does not acquire the native
Connect modal of a registered remote OpenAI app merely by installing it.

After one iPhone is linked, its GrantTap Settings can show an expiring QR to
add another iPhone or iPad as a controller of the same Live computers. That
device pairing is separate from inviting a person into Project Mesh. Offline
computers are listed as omitted and need a fresh QR when they reconnect.

The `connection_status` tool opens GrantTap's connection panel in the
conversation. It shows connection
status, relay and phone observations, provider readiness, Connect, Refresh
status, and confirmed Reconnect controls.

### Claude Code

Install the same local helper first, then install the plugin:

```bash
npm install --global granttap-mcp
granttap setup
claude plugin marketplace add sergii-ziborov/granttap-mcp
claude plugin install granttap@granttap
```

The plugin starts GrantTap as a local stdio process, so `/mcp` needs no sign-in.
Claude Desktop refuses a non-https sign-in page, which a loopback HTTP MCP at
`http://127.0.0.1:17342/mcp` can only offer; remove such a leftover user entry
with `claude mcp remove granttap -s user`. Claude Desktop's PATH omits version
managers such as nvm, so `granttap setup` must have started the monitor, which
keeps a link to its Node in `~/.granttap/bin`. Then run
`/granttap:granttap-connect` or ask Claude for connection status.

### Cursor

After installing the helper, pair on `granttap.com/connect` and in the
GrantTap app. Do not add GrantTap in Cursor Customize → MCPs. Cloud **Error
· fetch failed** is leftover HTTP at `http://127.0.0.1:17342/mcp` — a user
MCP row or an old plugin `mcp.json`. The Cursor plugin is stdio (`node -e`).
Cloud Agents start that process. They cannot fetch `http://127.0.0.1`.

### Grok Build

```bash
npm install --global granttap-mcp
granttap setup
grok plugin marketplace add sergii-ziborov/granttap-mcp
grok plugin install granttap --trust
```

Open `/mcps` and authenticate GrantTap, then run `/granttap-connect` or ask
Grok for connection status.

The `connect` tool is account first. A computer not signed in to GrantTap gets
the `sign_in` passkey page as its first step (and, when unpaired, a one-time QR
on the card as the fallback); a signed-in computer is linked by the phone signed
in to the same account, with no QR. It reuses a healthy pairing and never rotates
one merely to display a new QR.

## Included tools

- `connection_status` opens read-only connection controls and diagnostics.
- `set_runtime_auto_update` saves this computer's automatic runtime update setting.
- `sign_in` signs this computer in to your GrantTap account with your passkey on granttap.com.
- `connect` connects this computer account first, or reuses its current pairing.
- `reconnect` is the QR fallback; it creates a fresh pairing only after explicit confirmation.
- `remove_phones` asks the person on a phone to remove paired phones that are no longer used.
- `computer_load` reads this computer's load and where its disk space went; it deletes nothing.
- `connect_with_passkey` is the deprecated name of `sign_in`.
- `notify` sends a task update to GrantTap.
- `ask_yes_no` asks for an explicit yes or no decision.
- `ask` asks for typed or spoken input.
- `request_sign_in` sends a browser sign-in for an outside service (not GrantTap) to the phone and waits for it.

Codex, Claude Code, Cursor, and Grok Build use the persistent local HTTP
service installed by `granttap setup`. Get the iPhone and iPad app on the
[App Store](https://apps.apple.com/app/id6809739366); see
[granttap.com](https://granttap.com) for the privacy policy and terms.

The connection card has an **Automatic updates: On / Off** switch. The saved
choice applies to this computer's GrantTap runtime and is read by the running
service without a restart. Off keeps the current version and stops future checks
and activation. Service configuration can lock updates off. This switch controls
the GrantTap runtime; marketplace plugin updates remain managed by the coding app.

The plugin and local MCP runtime are distributed under the [GrantTap Commercial Source License](LICENSE).
The GrantTap iPhone, iPad and Apple Watch app and hosted service have separate terms.
