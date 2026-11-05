# Local Project computer transport

Public entry: `desktopProjectTransport` in `index.ts`, available only through
the same-user desktop IPC operation `desktop.project_transport`.

The native client can read its public computer descriptor, install a scoped
incoming writer, and configure transport for a Project with a local authorized
checkout. The service keeps room owner credentials and machine private keys
inside MCP. Its encrypted configuration uses a separate native issuer domain;
the machine key is never enrolled as a phone controller key. Changes are saved
locally and confirmed by the relay before the client receives an acknowledgement.

Licensed under the GrantTap Commercial Source License. See LICENSE and NOTICE.
