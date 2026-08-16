# Eleanor (beta 1)

*by The Dhozzi Group.*

A calm, composed AI companion built for Gen X+ women, most of whom are
capable and busy and have spent thirty years being condescended to by
technology. Eleanor does not open with a compliment on the question, does not
list her own features, does not use emoji, and does not use an em dash. She
looks things up rather than guessing from memory, and when she genuinely
cannot tell what is being asked, she asks one specific question rather than
guessing again.

**This is a harness, not a model.** Every request is served by Claude, on
Haiku 4.5. Eleanor is the persona, the tool surface, the session handling,
and the discovery behavior around that model, not a trained model of her
own.

## What this repo is for

This is Eleanor's standalone deployment: a small API server Base44 (or
anything else) calls over HTTP. It holds no accounts and no database — Base44
owns the user's identity, the conversation history it wants kept, and the
discovery ledger's state between sessions. This server's job is just to run
one message against Eleanor and hand back the result.

It shares its underlying agent core (`src/agent.ts`, `src/tools.ts`,
`src/config.ts`, `src/cost.ts`, `src/safety.ts`) with Chai-Kan, the coding
agent this was built from — the loop, the cache discipline, and the
degrade-on-error behavior are identical, and only the system prompt and the
tool surface differ between the two. Chai-Kan's own CLI, web UI, and
benchmark tooling are present in this tree too (inherited from that shared
core) but are not needed to run Eleanor; `npm start` in this repo runs
Eleanor by default.

## Setup

Node.js 20 or newer.

```bash
npm install
export ANTHROPIC_API_KEY=sk-ant-...   # from console.anthropic.com — never commit this
npm run eleanor-api                   # http://localhost:8081
```

## The API

**`POST /message`**

```json
{
  "userId": "the user's stable id",
  "message": "what she typed",
  "image": { "data": "base64", "mediaType": "image/jpeg" },
  "discoveryState": { "seen": ["web.search", "image.read"] }
}
```

`userId`, `message` are required. `image` and `discoveryState` are optional —
omit `discoveryState` on a user's first message. `image.mediaType` must be
one of `image/jpeg`, `image/png`, `image/gif`, `image/webp`. `message` is
capped at 8,000 characters.

Response:

```json
{
  "success": true,
  "reply": "Eleanor's answer",
  "cards": [{ "type": "compare_options", "options": [ ] }],
  "discoveryCard": { "capabilityId": "web.search", "did": "...", "next": "..." },
  "discoveryState": { "seen": ["web.search"] }
}
```

`cards` holds structured data for anything richer than prose (currently just
`compare_options` — two or three judged options with a reason each, built
after Eleanor has actually researched them with `web_search`/`web_fetch`,
never invented). `discoveryCard` is present only the first time a given
capability is shown to this user, ever — store `discoveryState` and send it
back on the next request, or that capability gets disclosed again, which is
exactly the behavior the whole discovery system exists to prevent.

A session per `userId` is kept warm in memory between requests so the prompt
cache stays warm across a conversation — a fresh agent per message would cost
roughly ten times as much. Sessions idle for 30 minutes are dropped; the next
message just starts fresh, with no history, since Base44 is the source of
truth for anything that needs to survive that.

**Rate limits, per `userId`:** 20 messages/minute (burst guard), 50
messages/day (the usage quota for this tier). Both in-memory, reset on a
server restart, and not shared across instances — fine for one deployment,
would need a shared store (Redis, etc.) for anything bigger.

**`GET /health`** — `{ "status": "ok", "sessions": <count> }`.

## Deploying

Build command: `npm run build`. Start command: `npm start`. Set
`ANTHROPIC_API_KEY` as an environment variable on whatever platform this
runs on — Railway, or otherwise — never in a file that gets committed.
`PORT` is read from the environment; 8081 is the fallback if it is unset.

## Tests

```bash
npm test        # everything, including the Chai-Kan-inherited suites
npm run typecheck
```

The tests specific to Eleanor: `test/eleanor.test.ts` (persona
parameterization, image content, structured cards, session reuse and
isolation, the busy-run guard, idle eviction), `test/discovery.test.ts` (the
disclosure rules, plus a regression check that card copy never drifts into
brochure language, an em dash, or emoji), `test/persona.test.ts` (the same
checks against Eleanor's actual system prompt), and `test/rateLimit.test.ts`.
