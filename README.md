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
