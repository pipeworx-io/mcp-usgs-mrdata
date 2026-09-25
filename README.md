# @pipeworx/usgs-mrdata

The USGS Mineral Resources Data System (MRDS) — ~300,000 mines, prospects,
occurrences and processing plants worldwide, with commodity, deposit type,
development status, production history and bibliography.

Part of [Pipeworx](https://pipeworx.io) — an MCP gateway connecting AI agents to 1679+ live data sources.

## Tools

- `mrdata_search_deposits(bbox?, name_contains?, commodity?, limit?)` — sites with deposit id, name, development status, coordinates and commodity codes.
- `mrdata_deposit(dep_id, sections?)` — the full record for one deposit.
- `mrdata_commodities(bbox?, sample_size?)` — commodity site counts for an area, or the code reference list.

## Auth

Keyless.

## Data sources

- `https://mrdata.usgs.gov/services/wfs/mrds` — OGC WFS point layer (search).
- `https://mrdata.usgs.gov/mrds/json/<dep_id>` — full record for one deposit.

Things the next person would otherwise rediscover:

- **The WFS speaks GML only.** `outputformat=geojson` and `application/json` are
  both rejected by name; only GML 2.1.2 and GML 3.1.1 are advertised.
- **Use `version=1.0.0` for bbox queries.** WFS 1.1.0 flips EPSG:4326 to lat,lon
  and a 1.0.0-style bbox then returns ZERO features with no error at all.
- **`PropertyIsEqualTo` on `dep_id` fails server-side.** `PropertyIsLike` with no
  wildcard works, and is what exact lookup uses.
- **The per-deposit JSON is a PATH**, `/mrds/json/<dep_id>`. The query-parameter
  form answers HTTP 400 with an empty body.
- **Commodity codes are not element symbols.** MRDS codes non-metals with three
  letters (`SDG` sand and gravel, `STN` stone, `CLY` clay, `LST` limestone) and
  qualifies them with a suffix (`STN_C` crushed stone, `PGE_PT` platinum). `SDG`
  is the single commonest code in the western US — a two-letter-symbol table
  leaves it, and most of the database, unnamed.

## Quick Start

Add to your MCP client (Claude Desktop, Cursor, Windsurf, etc.):

```json
{
  "mcpServers": {
    "usgs-mrdata": {
      "url": "https://gateway.pipeworx.io/usgs-mrdata/mcp"
    }
  }
}
```

### What this endpoint actually serves

`tools/list` at `https://gateway.pipeworx.io/usgs-mrdata/mcp` returns the tools in the table
above **plus the shared Pipeworx meta-tools** — `ask_pipeworx`,
`discover_tools`, `search_within`, `remember`/`recall` and the rest of the
gateway-wide set. So the tool count you see is larger than this table: a
single-pack endpoint currently lists roughly 30 shared tools alongside the
pack's own. The connection's `initialize` response states its exact scope, and
is the authoritative answer for a given day.

This is deliberate, not multiplexing by accident. The meta-tools are what let a
scoped connection answer a question this pack does not cover — via
`ask_pipeworx`, which routes across the whole catalog — without you adding a
second MCP server. There is currently no way to mount a pack endpoint without
them; if the extra schemas cost you more context than the routing is worth,
connect to the full gateway once rather than to several pack endpoints.

Or connect to the full Pipeworx gateway to get every pack's tools listed
directly, instead of just this one's:

```json
{
  "mcpServers": {
    "pipeworx": {
      "url": "https://gateway.pipeworx.io/mcp"
    }
  }
}
```

Both URLs reach the same gateway and the same 1679+ data sources. The
only difference is which pack's tools are listed **directly**; `ask_pipeworx`
reaches all of them from either one.

## No MCP client? Call it over HTTP

```bash
curl -X POST https://gateway.pipeworx.io/v1/tools/mrdata_search_deposits \
  -H 'Content-Type: application/json' \
  -d '{"bbox":"-112.2,33.4,-112.0,33.6","limit":5}'
```

No account needed for the first calls. Inspect any tool: `GET https://gateway.pipeworx.io/v1/tools/mrdata_search_deposits`. Find one: `POST https://gateway.pipeworx.io/v1/tools/search_packs` with `{"query":"..."}`.

## Standalone (no gateway account)

This package also runs as a local stdio MCP server — no Pipeworx account, no
gateway round-trip:

```json
{
  "mcpServers": {
    "usgs-mrdata": {
      "command": "npx",
      "args": ["-y", "@pipeworx/mcp-usgs-mrdata"]
    }
  }
}
```

Or run it directly to confirm it starts:

```bash
npx -y @pipeworx/mcp-usgs-mrdata
```

It speaks MCP over stdin/stdout and answers `initialize`/`tools/list`/`tools/call`
for **only** this pack's tools — none of the shared meta-tools the gateway
connection above adds. Same source, same tools, no ask_pipeworx routing.

## Using with ask_pipeworx

Instead of calling tools directly, you can ask questions in plain English —
this works on the pack endpoint above as well as on the full gateway:

```
ask_pipeworx({ question: "your question about Usgs Mrdata data" })
```

The gateway picks the right tool and fills the arguments automatically.

## More

- [Docs and guides](https://pipeworx.io/docs)
- [pipeworx.io](https://pipeworx.io)

## License

MIT
