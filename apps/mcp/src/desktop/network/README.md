# Desktop device network

`DesktopNetworkController` exposes bounded status, configuration and own-relay
installation/start/stop through the same-user desktop channel. It is not a
remotely callable provider MCP tool. The native Mac app handles the purchased
Mac entitlement before offering administration.

The relay is obtained from one exact public Git commit, installed without npm
package lifecycle scripts and keeps its own SQLite database. Existing source
or installations are retained instead of silently overwritten. The relay binds
loopback; the user supplies a TLS proxy, VPN or reachable TLS address. It is
never advertised as automatically bypassing a router or firewall. Stopping
checks the owned command path and never signals an unrelated reused PID.

Runtime and installation behavior tests are beside `bridge/src/device-network`.

This runtime module is covered by the repository MIT License.
