# Third-party notices

GrantTap MCP is distributed under the MIT License. Third-party components
retain their own licenses; the GrantTap license does not replace or restrict
those terms.

The npm package declares, rather than vendors, these direct runtime
dependencies. Their packages carry the applicable license texts:

| Component | License |
| --- | --- |
| `@modelcontextprotocol/sdk` | MIT |
| `express` | MIT |
| `qrcode` | MIT |
| `tsx` | MIT |
| `tweetnacl` | The Unlicense |
| `ws` | MIT |
| `zod` | MIT |

The unpublished Rust workspace also depends on separately licensed components,
including `mcport` (MIT), `blazingly-json` (MIT), `serde` (MIT OR Apache-2.0), and
BlindPlane crates (MIT OR Apache-2.0). Binary distributions must retain the
complete license texts required by the exact dependency versions they contain.

## Optional SweepLoom integration

Provider storage inspection may invoke a separately installed SweepLoom CLI
([source](https://github.com/Weavatrix/sweeploom), MPL-2.0). No SweepLoom source or
binary is included in this npm package. Its license remains independent; the
GrantTap MIT license does not apply to SweepLoom.
