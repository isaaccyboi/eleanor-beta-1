/**
 * Eleanor API server.
 *
 * Base44 owns accounts, storage, and the frontend; this exposes just enough
 * for it to drive a conversation:
 *
 *   POST /message — send one message (with an optional image), get back
 *   Eleanor's reply, any structured cards, and a discovery card if one fired.
 *   GET  /health  — liveness probe.
 *
 * Stateless per request, except for the warm session kept in memory between
 * calls for prompt-cache reuse (see eleanor/sessions.ts). Everything that
 * needs to survive across requests but outlive the in-memory session —
 * conversation history for a returning user, the discovery ledger's "seen"
 * list — is round-tripped through the request/response instead: Base44 sends
 * `discoveryState` in, this returns the updated `discoveryState`, and Base44
 * is responsible for storing and re-sending it. This server holds no
 * database of its own.
 */

import express, { type Request, type Response } from "express";
import type { ImageMediaType } from "./agent.js";
import { EleanorSessionStore, SessionBusyError } from "./eleanor/sessions.js";
import { DiscoveryLedger, type DiscoveryCard, type DiscoveryState } from "./eleanor/discovery.js";
import { RateLimiter } from "./eleanor/rateLimit.js";

const app = express();
const PORT = Number(process.env.PORT) || 8081;
const MAX_IMAGE_BASE64_CHARS = 8_000_000; // ~6MB decoded, generous for a phone photo
const MAX_MESSAGE_CHARS = 8_000; // generous for a real message, not a pasted document

app.use(express.json({ limit: "10mb" }));

const store = new EleanorSessionStore();
// 20 messages/minute/user: a burst guard. A real conversation never
// approaches this; a runaway client (retry loop, bug) hits it fast and gets
// a 429 instead of an unbounded API bill.
const burstLimiter = new RateLimiter(20, 60_000);
// 50 messages/day/user: the actual usage quota for this tier, on Haiku.
// Same in-memory limitation as the burst limiter (resets on restart, not
// shared across instances) — fine for one beta deployment, would need a
// shared store to hold for real once this runs multi-instance.
const dailyLimiter = new RateLimiter(50, 24 * 60 * 60 * 1000);

const VALID_MEDIA_TYPES: readonly ImageMediaType[] = ["image/jpeg", "image/png", "image/gif", "image/webp"];

interface MessageRequest {
  userId?: unknown;
  message?: unknown;
  image?: { data?: unknown; mediaType?: unknown };
  discoveryState?: { seen?: unknown };
}

interface MessageResponse {
  success: boolean;
  reply: string;
  cards: Record<string, unknown>[];
  discoveryCard?: DiscoveryCard;
  discoveryState: DiscoveryState;
  error?: string;
}

app.post("/message", async (req: Request, res: Response<MessageResponse>) => {
  const body = (req.body ?? {}) as MessageRequest;
  const emptyState: DiscoveryState = { seen: [] };

  const userId = typeof body.userId === "string" ? body.userId : "";
  if (!userId.trim()) {
    res.status(400).json({ success: false, reply: "", cards: [], discoveryState: emptyState, error: "Missing or invalid 'userId'" });
    return;
  }

  if (!burstLimiter.allow(userId)) {
    res.status(429).json({ success: false, reply: "", cards: [], discoveryState: emptyState, error: "Too many messages. Wait a moment and try again." });
    return;
  }

  if (!dailyLimiter.allow(userId)) {
    res.status(429).json({ success: false, reply: "", cards: [], discoveryState: emptyState, error: "Today's message limit has been reached. It resets tomorrow." });
    return;
  }

  const message = typeof body.message === "string" ? body.message : "";
  if (!message.trim()) {
    res.status(400).json({ success: false, reply: "", cards: [], discoveryState: emptyState, error: "Missing or invalid 'message'" });
    return;
  }
  if (message.length > MAX_MESSAGE_CHARS) {
    res.status(400).json({ success: false, reply: "", cards: [], discoveryState: emptyState, error: `'message' is too long (max ${MAX_MESSAGE_CHARS} characters)` });
    return;
  }

  let images: { data: string; mediaType: ImageMediaType }[] | undefined;
  let sawImage = false;
  if (body.image) {
    const { data, mediaType } = body.image;
    if (typeof data !== "string" || !data) {
      res.status(400).json({ success: false, reply: "", cards: [], discoveryState: emptyState, error: "image.data must be a non-empty base64 string" });
      return;
    }
    if (data.length > MAX_IMAGE_BASE64_CHARS) {
      res.status(400).json({ success: false, reply: "", cards: [], discoveryState: emptyState, error: "image is too large" });
      return;
    }
    if (typeof mediaType !== "string" || !VALID_MEDIA_TYPES.includes(mediaType as ImageMediaType)) {
      res.status(400).json({
        success: false,
        reply: "",
        cards: [],
        discoveryState: emptyState,
        error: `image.mediaType must be one of: ${VALID_MEDIA_TYPES.join(", ")}`,
      });
      return;
    }
    images = [{ data, mediaType: mediaType as ImageMediaType }];
    sawImage = true;
  }

  const seen = Array.isArray(body.discoveryState?.seen)
    ? body.discoveryState.seen.filter((s): s is string => typeof s === "string")
    : [];
  const ledger = new DiscoveryLedger({ seen });

  // Vision content isn't dispatched as a tool call (see eleanor/tools.ts), so
  // there's no onToolResult event to hook — record it directly, and only on
  // an actual attached image, not just because the field was present.
  if (sawImage) ledger.record("image_read", false);

  let reply = "";
  const cards: Record<string, unknown>[] = [];

  try {
    await store.send(userId, {
      onText: (delta) => {
        reply += delta;
      },
      onToolResult: (name, _result, isError) => {
        ledger.record(name, isError);
      },
      onToolCard: (_name, card) => {
        cards.push(card);
      },
    }, async (agent) => {
      await agent.run({ text: message, images });
    });
  } catch (error) {
    if (error instanceof SessionBusyError) {
      res.status(409).json({ success: false, reply: "", cards: [], discoveryState: { seen }, error: error.message });
      return;
    }
    const messageText = error instanceof Error ? error.message : String(error);
    res.status(500).json({ success: false, reply: "", cards: [], discoveryState: { seen }, error: messageText });
    return;
  }

  const discoveryCard = ledger.settle();
  res.json({
    success: true,
    reply,
    cards,
    ...(discoveryCard ? { discoveryCard } : {}),
    discoveryState: ledger.toState(),
  });
});

app.get("/health", (_req: Request, res: Response) => {
  res.json({ status: "ok", sessions: store.size });
});

app.listen(PORT, () => {
  console.log(`Eleanor API server listening on port ${PORT}`);
  console.log("POST /message: send a message");
  console.log("GET  /health:  health check");
});
