# Session monitor

`index.ts` owns discovery, subscriptions and phone delivery for this computer.
Chat catalogs publish independently of background Mesh enrichment. The Mesh
publisher reuses known native identities and yields between Projects.

Architecture responses acknowledge their explicit request. Coalesced builds
retain every controller's receipt; periodic cached reports remain ordinary Mesh
snapshots. Repository analysis uses its own Engine socket to keep policy and
Backbone requests responsive.

Integration tests remain in `tests/monitor`; background publication tests live
beside `mesh-publication`. This module uses the repository Apache License 2.0.

`message-delivery/index.ts` reserves the durable delivery lease, then
emits a non-terminal processing receipt only after workspace, attachment and
provider validation. Duplicate validated requests replay that receipt without
starting another provider run. A message is delivered once the agent has
taken it: `message-delivery/acceptance.ts` reports an immediate failure as that
failure and accepts a run still going after a short window, so the
eleven-minute lease only has to cover that window. The answer, or the reason a
long run stopped, reaches the chat when the run ends; unattended runs are
bounded at six hours. New-task startup events are status updates; the
correlated result is terminal. Delivery integration tests live in `tests/delivery`.
