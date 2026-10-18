# Task computer selection

Public entry: `index.ts`. Chooses a compatible computer within the exact Project,
repository revision, enabled computer policy, provider, model and effort.
Fresh measured capacity and confirmed tool availability are required. Missing
facts remain unknown. Cross-platform moves require explicit portable work and
policy permission; GPU work requires observed matching hardware. Cooldown,
visited endpoints and a hop limit prevent repeated transfers between hosts.

Selection does not itself grant access or start work. Runtime transport and the
receiving computer must validate the Project grant, checkout and current policy
before executing a transfer.

Tests: `tests/selection.test.ts` exercises compatible capacity, disabled routing,
unknown/stale reports, policy/repository/model/effort mismatches and portable
NVIDIA work.

Licensed under the GrantTap Commercial Source License. See LICENSE and NOTICE.
