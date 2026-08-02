# kp-hackathon — session handoff

## State as of setup

- Repo: `github.com/tongliu999/kp-hackathon`, cloned at `~/kp-hackathon`.
- **The remote contains only `README.md`.** `package.json` and `src/` (Agent class + readline REPL)
  are untracked local files — never committed, never pushed. Teammates do not have them.
- Only branch is `main`. No `talia/*` branch created yet.

## Tooling installed during setup

- node v26.5.1 + npm 11.17.0 (Homebrew)
- gh 2.97.0 (Homebrew) — **not yet authenticated**, run `gh auth login`
- claude CLI 2.1.220 (npm global)

## Linear MCP

Configured in two places so it loads regardless of working directory:
- `~/.claude.json` → local scope for `/Users/taliakusmirek`
- `~/kp-hackathon/.mcp.json` → project scope for the repo

Endpoint `https://mcp.linear.app/mcp` (HTTP). Verified live: returns 401 without auth.
The `/sse` endpoint is dead (404) — do not use it.
Auto-approved via `.claude/settings.local.json` → `enabledMcpjsonServers: ["linear"]`.

## Remaining work

1. Authenticate Linear (`/mcp` → linear → Authenticate).
2. Pull Talia's assigned milestone from Linear.
3. Decide whether the untracked `src/` scaffold is the foundation (commit to `main`) or throwaway.
4. Create branch `talia/<milestone-slug>`.
5. Write a build plan — workstreams, what to verify, collision points — **for Talia to review before
   any agents are spawned.** She explicitly asked to check the plan first.
6. Caveat to raise: the repo is tiny, so several parallel agents would contend over the same two
   files. Recommend a sequential foundation pass before fanning out.
