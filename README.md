# Git Forge — a GitHub-compatible git forge in pure Node.js

[![GitHub-compatible git forge](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01)
[![Rank](https://make.fun/badge/github-core-clone-01/norv33/git-forge/rank.svg)](https://make.fun/bounty/github-core-clone-01)
[![Reward](https://make.fun/badge/github-core-clone-01/norv33/git-forge/reward.svg)](https://make.fun/bounty/github-core-clone-01)

Entry for the [make.fun bounty "Build a GitHub-compatible git forge"](https://make.fun/bounty/github-core-clone-01).

## What it is

One process (`node main.ts`, Node 22, standard library only — no
dependencies, no git binary) that serves four surfaces over one HTTP port:

- **Git smart HTTP** — `/{owner}/{repo}.git` with upload-pack (protocol v2
  and v0) and receive-pack (v0): clone, fetch, shallow fetch, push with
  fast-forward checks, annotated tags, ls-refs.
- **REST v3** — `/api/v3`: repositories, branches, commits, refs, contents,
  labels, issues, pull requests (including squash merge).
- **GraphQL v4** — `/api/graphql`: viewer, repository, node, issues and pull
  request connections with cursor pagination, the create/close/merge
  mutations, and `__type` introspection.
- **MCP** — `/mcp`: JSON-RPC 2.0 over Streamable HTTP, revision 2026-07-28
  (`server/discover`) with a legacy `initialize` fallback; eight tools
  (`create_repo`, `get_repo`, `create_issue`, `list_issues`, `get_issue`,
  `create_pull_request`, `merge_pull_request`, `list_repos`).

State is in-memory and deterministic: the logical clock and the random
seed come from `MAKEFUN_TRIAL_NOW` / `MAKEFUN_TRIAL_SEED`, so a replay
produces the same state.

## Running it

```sh
MAKEFUN_SHOP_TOKEN=<token> node --experimental-strip-types main.ts
```

With `MAKEFUN_ENV_URL` set it registers its port with the trial harness
and exits when the trial is done; without it, it runs standalone on an
ephemeral port and prints the address.

## Scope, honestly

This is a forge built in one night for a competition, not a production
replacement for GitHub: it stores repositories in memory, supports one
authenticated viewer, speaks SHA-1 objects only, and implements the
protocol surfaces the competition suite exercises. No web UI, no webhooks,
no actions, no search, no persistence across restarts.

## Local conformance (kit's own runner, `sdk/run.ts`)

Against the practice scenario, two consecutive full runs passed **120/120**
checks (git 30/30, repos 15/15, issues 15/15, pulls 20/20, protocol 5/5,
GraphQL 20/20, MCP 15/15), with the four benchmark workloads scoring
190–194/200 — total **990–994/1,000** locally. The sealed final runs the
same suite on fresh seeded data in the trial pod, so a green local run is
evidence, not a guarantee: the prize needs a score strictly above the
reference forge's, and the final is staged (top 60 run all three
instances).
