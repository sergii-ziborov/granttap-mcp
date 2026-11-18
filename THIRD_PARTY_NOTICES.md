# Third-party notices

First-party GrantTap MCP is distributed under the GrantTap Commercial Source License. Third-party components
retain their own licenses; the GrantTap license does not replace or restrict
those terms.

The npm package declares, rather than vendors, these direct runtime
dependencies. Their packages carry the applicable license texts:

`THIRD_PARTY_LICENSES.txt` contains the original notices for the full resolved
runtime dependency graph, including optional platform packages. Package
boundaries and upstream grants remain separate from GrantTap's first-party commercial license.

| Component | License |
| --- | --- |
| `@modelcontextprotocol/sdk` | MIT |
| `express` | MIT |
| `qrcode` | MIT |
| `tsx` | MIT |
| `tweetnacl` | The Unlicense |
| `ws` | MIT |
| `zod` | MIT |
| `smol-toml` | BSD-3-Clause |
| `marked` | MIT, with the original Markdown notice retained |
| `entities` | BSD-2-Clause |

The unpublished Rust workspace also depends on separately licensed components,
including `mcport` (MIT), `blazingly-json` (MIT), `serde` (MIT OR Apache-2.0), and
BlindPlane crates (MIT OR Apache-2.0). Binary distributions must retain the
complete license texts required by the exact dependency versions they contain.

## Ported source: lot-map

The live map's ten stations and the rules that read a tool call or a shell
command line for its station are ported from
[lot-map](https://github.com/alexeyw/lot-map) by Aleksei Volodin (MIT,
commit `340b985`), a Claude Code mod that draws the same map in a pane beside
the chat. The ported code is in `apps/bridge/src/live-map/classification/`
and the station list in `packages/protocol/messages/live-map/`; each file
names its origin, and `THIRD_PARTY_LICENSES.txt` keeps lot-map's copyright and
license text. Those portions remain under the MIT license; the GrantTap
first-party license does not apply to them. GrantTap does not ship or run the
mod itself.

## Optional SweepLoom integration

Provider storage inspection may invoke a separately installed SweepLoom CLI
([source](https://github.com/Weavatrix/sweeploom), MPL-2.0). No SweepLoom source or
binary is included in this npm package. Its license remains independent; the
GrantTap first-party commercial license does not apply to SweepLoom.
