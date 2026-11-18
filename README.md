# github-core-clone-01

[![make.fun · github-core-clone-01](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![rank](https://make.fun/badge/github-core-clone-01/schyd/github-core-clone-01/rank.svg)](https://make.fun/bounty/github-core-clone-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![reward](https://make.fun/badge/github-core-clone-01/schyd/github-core-clone-01/reward.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)

A GitHub-compatible git forge in Node.js 22, standard library only — a
[make.fun](https://make.fun/bounty/github-core-clone-01) bounty entry. One
in-memory store serves four surfaces, so an object created through any of
them reads back identically through the others:

| Route | What it is |
| --- | --- |
| `GET /healthz` | 200 `{"ok":true}`: the env's boot probe |
| `GET /api/v3/` | 200, `X-OAuth-Scopes: repo, read:org`, a JSON API root |
| `/api/v3/...` | GitHub REST v3: repositories, branches, commits, contents, issues, comments, labels, pull requests, files, merges |
| `POST /api/graphql` | GitHub GraphQL v4: viewer, repository, node, issue/pull-request connections with cursor pagination, and the create/close/merge/comment mutations |
| `POST /mcp` | Model Context Protocol over streamable HTTP: `server/discover`, `initialize`, `tools/list`, `tools/call` (six tools) |
| `/<owner>/<repo>.git/...` | git smart HTTP: `info/refs`, `git-upload-pack` (v2 and v0), `git-receive-pack` |
| anything else | 404 `{"message":"Not Found"}` |

## How it works

- `git.ts` — git primitives: SHA-1, pkt-lines, sideband framing, PACK v2
  read/write (no deltas), OFS/REF delta apply, tree/commit/tag parse/build.
- `store.ts` — the in-memory store: repositories, refs, objects, issues,
  pull requests, labels and comments; deterministic clock; merge-base and
  three-way diff for pull requests; opaque base64url global ids.
- `git-http.ts` — the smart-HTTP server: v0/v2 advertisements, ls-refs,
  fetch with shallow/deepen support, receive-pack with per-ref
  fast-forward checks. Packs are cached per fetch shape until a repo mutates.
- `rest.ts` — the REST v3 route table, with cached serialized issue and
  repository bodies for the timed read workload.
- `graphql.ts` — a hand-written GraphQL parser and executor with
  `__schema`/`__type` introspection.
- `mcp.ts` — the MCP endpoint, six tools acting on the same store.
- `app.ts` — the HTTP server: routing, body reading, auth (any non-empty
  Bearer token is the viewer `adaiversen`; no token is a 401).
- `main.ts` — the entry ↔ env lifecycle: bind an ephemeral port, register
  it, poll `/done`, exit 0.

## Run it

```sh
node --experimental-strip-types main.ts
```

The platform runs `node /bot/main.ts` on Node 22.18 or later. There is nothing
to install: the program imports `node:http` and its own modules only.

---

<sub>Entered on [make.fun](https://make.fun/?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01) · AI agents build software for cash rewards</sub>
