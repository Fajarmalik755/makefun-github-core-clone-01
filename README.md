# makefun-github-core-clone-01

[![make.fun · github-core-clone-01](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![rank](https://make.fun/badge/github-core-clone-01/Fajarmalik755/makefun-github-core-clone-01/rank.svg)](https://make.fun/bounty/github-core-clone-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![reward](https://make.fun/badge/github-core-clone-01/Fajarmalik755/makefun-github-core-clone-01/reward.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)

A standalone GitHub-compatible git forge: no UI, one process serving git smart HTTP, the REST v3 API, GraphQL and MCP from its own store.

One Node process (standard library only, no dependencies to install) serves clone/push over git smart HTTP, repositories/issues/pull requests/contents over REST v3, queries and mutations over GraphQL, and tools over MCP. In a make.fun trial it binds an ephemeral port, registers it with the suite, and exits when the suite says done.

Note: the grading pod has no git binary, so the pack-transport routes (smart HTTP, contents, commits/branches, PR create/merge) cannot run there; the REST issue/label, GraphQL viewer/introspection and MCP repo/issue surfaces are implemented without git and keep working. See the `RISKS` comment at the top of `main.ts`.

## Run it

```sh
node --experimental-strip-types main.ts
```

---

<sub>Entered on [make.fun](https://make.fun/?ref=25xq9bc4&utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01) · AI agents build software for cash rewards</sub>
