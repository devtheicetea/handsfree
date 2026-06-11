# Handsfree Bridge

Backend that drives Claude Code via the Claude Agent SDK and exposes a
Tailscale-only WebSocket. Phase 1: text-only round-trip (no audio, no iOS).

The iOS voice client lives in a separate private repo and talks to this bridge
over the WebSocket protocol in `docs/superpowers/specs/`.

## Prerequisites
- Node 20+
- Claude Code installed and logged in with a Claude Pro/Max subscription
- `ANTHROPIC_API_KEY` **unset** (so it runs on the subscription, not pay-as-you-go API billing)

## Install & build
```
npm install
npm run build
```

## Run
```
HANDSFREE_BIND=<your-tailscale-ip> node dist/index.js
```

## Config (environment variables)
- `HANDSFREE_PORT` — listen port (default `8744`)
- `HANDSFREE_BIND` — bind address (default `0.0.0.0`; set to your Mac's Tailscale IP in production)
- `HANDSFREE_TOKEN` — optional shared secret; the client must send it in its `hello`
- `HANDSFREE_SAFELIST` — comma-separated tools auto-approved in `safelist` permission mode (default: `Read,Grep,Glob,LS,TodoWrite`)
- `HANDSFREE_CODEX_PATH` — full path to the `codex` binary; omit to resolve from PATH

## Agents

The bridge runs Claude Code (default) and OpenAI Codex sessions side by side —
one live session per (project, agent). Clients pick the agent per
`open_session` with `agent: "claude" | "codex"` (defaults to `"claude"`;
protocol v0.2.0).

### Codex prerequisites

- Install the codex CLI (`npm i -g @openai/codex` or `brew install codex`) and
  log in (`codex login`). The bridge resolves `codex` from PATH; override with
  `HANDSFREE_CODEX_PATH=/path/to/codex`.
- Codex runs sandboxed (workspace-write) with approvals on request; the bridge
  remains the permission gate. Commands always ask (`CodexExec`); file changes
  inside the project auto-allow in safelist mode (`CodexApplyPatch`), outside
  ask (`CodexApplyPatchOutside`).
- Codex sessions are discovered/resumed/replayed from `~/.codex/sessions`.

## Tests
```
npm test                          # unit tests
HANDSFREE_E2E=1 npm test          # also runs the real Agent SDK text-loop test (needs Claude login)
```

## Manual text-loop client
With the bridge running, in another terminal:
```
node test/client.ts               # Node 22.6+ (built-in TS). Otherwise: npx tsx test/client.ts
```
Then: pick a project → type a prompt → watch streamed text → answer permission prompts.
Commands: `/auto`, `/ask`, `/abort`, `/quit`.

## License
MIT
