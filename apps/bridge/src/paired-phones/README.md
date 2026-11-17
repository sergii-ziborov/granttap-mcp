# Paired phones

`index.ts` is the public entry point. This module owns the phones and iPads a computer accepts: listing them,
removing them, and the place a new phone takes when the computer is full.

- `roster.ts` lists every key `machine.json` accepts right now: the first pairing (`peerPublicKey`), then the
  added phones (`extraPeerPublicKeys`) in the order they were added. A phone is named by `id`, the sha256 of its
  public key in hex, and `label`, the first six characters of the id; its key never leaves the computer. Names,
  last-seen and added-at times come from `presence.json`. Added-at is recorded only for keys added since phone
  management shipped, so older keys have none. An unscanned key whose QR expired is not accepted and is not listed.
- `removal.ts` removes keys in one write under the `machine.json` lock, through the existing config writer.
  `controllerPeerGate` rereads `machine.json` before every send and every received message, so a removed phone
  stops receiving sealed broadcasts at once in every running process, the first pairing included. Removing the
  first pairing hands its place to the remaining phone heard from most recently (a scanned one before an open
  QR). At least one phone always stays. The enrollment journal and presence entries of a removed key go too.
- `admission.ts` authorizes a new phone key against the pairing as it is on disk at that moment.
- `device-actions.ts` carries out the phone's `device.manage` requests below.

## The limit and who gives way

A computer accepts its first pairing plus 16 added phones. At the limit a new phone is no longer refused:
the added phone idle longest gives its place, but only if it has not reached the computer, and was not added,
for at least 30 days (`EVICTION_IDLE_DAYS`). A phone never seen with no recorded added-at counts as idle
longest; among equals the one added earlier goes first. The first pairing, a phone seen or added within 30
days, and a key whose QR is still open are never taken. When no phone qualifies the new phone is refused with
a message pointing to Devices → this computer → Phones. Each eviction writes one helper-log line with the
evicted phone's label and when it was last seen. The same rule applies to a QR from `reconnect mode=add_device`,
`granttap phone add`, the phone app's "add a device" request and an account link.

After the first pairing is removed, the phone half saved for `reconnect` belongs to a key the computer no
longer accepts, so a reconnect QR enrolls a new added key instead of offering that half again.

## Phone requests (`device.manage`)

The phone app uses the same encrypted `device.manage` request it uses for the computer's MCP, cache and
coding-agent controls; answers go only to the phone that asked. The fields are defined in
`packages/protocol/messages/device/management.ts`.

| Request | Fields | What happens |
| --- | --- | --- |
| `action: "status"` | — | The answer's `snapshot.phones` lists every phone (below). Absent from MCP 0.8.187 and older. |
| `action: "phones-remove"` | `computerId`, `phoneIds` (1–32 ids) | Removes those other phones. Refused when the list holds the phone asking. Ids already gone are skipped. |
| `action: "phones-remove-stale"` | `computerId`, `notSeenForDays` (1–3650) | Removes every other phone not seen, and not added, for that many days. Never the phone asking. |
| `action: "phones-unpair-self"` | `computerId` | Removes the phone asking. Refused when it is the only phone. The answer is sent before the key is removed. |

Each phone in `snapshot.phones`: `id` (64 hex), `label` (6 hex), `name` (when the phone reported one),
`thisPhone`, `primary` (the first pairing), `addedAt` and `lastSeenAt` (milliseconds; absent when unknown).
A removal answers `device.manage.result` with `phase: "completed"` and `removedPhoneIds`, plus the updated
`snapshot` except after `phones-unpair-self`; a refusal answers `phase: "failed"` with the reason in `message`.

## Agents

`remove_phones` in `apps/mcp/src/mcp-tools/phones` lets an agent ask for stale phones to be removed; the person
confirms on a phone with the existing yes/no question, and the phone that answered, any phone heard from while
the question was open, and the last phone stay.

Tests live in `tests/` and use a temporary `GRANTTAP_CONFIG_DIR`.

License: this module is distributed under the GrantTap Commercial Source License in the repository-root
`LICENSE` file.
