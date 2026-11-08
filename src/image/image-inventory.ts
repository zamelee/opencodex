/**
 * Inventory of the images in an outgoing request body.
 *
 * WHY: the budget brake used to drop images by ONE rule — "oldest first" — which is
 * wrong in both directions:
 *   - it drops the OLDEST image first, but an old screenshot may be the only record of
 *     an error the user is still chasing, while the newest one may be a duplicate;
 *   - it treats every image as equally valuable, so a 4k screenshot and a 32x32 icon
 *     are dropped for the same "price".
 *
 * The inventory gives the policy the facts it needs to decide: where each image sits
 * (which turn, whether it is in a tool result), how big it is in pixels, whether it
 * duplicates another image, and how many upstream tokens it costs.
 */

import { createHash } from "node:crypto";
import { sniffImageDimensions } from "../adapters/anthropic-image-guard";
import { base64OfDataUrl } from "../lib/token-composition";

/** Where an image block lives in the request. */
export type ImageKind =
  /** A native Anthropic/Responses image block the upstream bills as vision. */
  | "native"
  /** A payload the upstream cannot render (not a usable data URL) — billed as TEXT. */
  | "unusable";

/**
 * The wire format the image block is written in.
 *
 * It decides where a downsampled payload has to be written back:
 *   anthropic        -> block.source.data + block.source.media_type
 *   chat-completions -> block.image_url.url (a full data URL)
 *   responses        -> block.image_url (a full data URL, as a string)
 */
export type ImageWireShape = "anthropic" | "chat-completions" | "responses";

export interface ImageInventoryEntry {
  /** Position of this image in document order (0-based). */
  ordinal: number;
  /** The array that holds the block (mutated in place by the policy). */
  container: unknown[];
  /** Index of the block inside `container`. */
  index: number;
  kind: ImageKind;
  /** Base64 payload, for native images. */
  data?: string;
  /** Payload length in characters — the raw cost of the block on the wire. */
  payloadChars: number;
  width?: number;
  height?: number;
  /** Index of the message this image belongs to (turn order). */
  messageIndex: number;
  /** Index of the USER turn this image belongs to (0-based). */
  turnIndex: number;
  /** True when the image rides inside a tool_result rather than a user turn. */
  inToolResult: boolean;
  /** SHA-256 of the payload — identical payloads are duplicates of each other. */
  hash?: string;
  /** The wire format the block is written in. */
  shape?: ImageWireShape;
}

export interface ImageInventory {
  entries: ImageInventoryEntry[];
  /** Hash -> ordinal of the FIRST image with that payload. */
  firstOccurrence: Map<string, number>;
}

function isHttpUrl(value: unknown): boolean {
  return typeof value === "string" && /^https?:\/\//i.test(value);
}

function hashOf(data: string): string {
  return createHash("sha256").update(data).digest("hex");
}

/**
 * Walk a wire body and collect every image block, in any of the three shapes we send.
 *
 * Pure: it only reads. The policy mutates the containers afterwards, so the inventory
 * is a snapshot of the body as it was built.
 *
 * The SHAPE matters: an image is written differently in each format, so the inventory
 * records which one it found so a downsampled payload can be written back where it came
 * from. Getting this wrong would silently corrupt the request.
 */
export function collectImageInventory(wireBody: unknown): ImageInventory {
  const entries: ImageInventoryEntry[] = [];
  const firstOccurrence = new Map<string, number>();
  const body = (wireBody ?? {}) as { messages?: unknown };
  const messages = Array.isArray(body.messages) ? body.messages : [];

  /**
   * Record one image block. `data` is the bare base64 payload when the upstream can render
   * it (billed as vision); `url` is whatever the block carried otherwise (billed as text).
   */
  const push = (
    container: unknown[],
    index: number,
    shape: ImageWireShape,
    payload: { data?: string; url?: string },
    ctx: { messageIndex: number; turnIndex: number; inToolResult: boolean },
  ): void => {
    const data = payload.data ?? "";
    const url = payload.url ?? "";
    const usable = data.length > 0;
    const dims = usable ? sniffImageDimensions(data) : null;
    const hash = usable ? hashOf(data) : undefined;
    const entry: ImageInventoryEntry = {
      ordinal: entries.length,
      container,
      index,
      kind: usable ? "native" : "unusable",
      ...(usable ? { data } : {}),
      payloadChars: usable ? data.length : (isHttpUrl(url) ? 0 : url.length),
      ...(dims ? { width: dims.width, height: dims.height } : {}),
      messageIndex: ctx.messageIndex,
      turnIndex: ctx.turnIndex,
      inToolResult: ctx.inToolResult,
      ...(hash ? { hash } : {}),
      shape,
    };
    entries.push(entry);
    if (hash && !firstOccurrence.has(hash)) firstOccurrence.set(hash, entry.ordinal);
  };

  // Anthropic shape: { type: "image", source: { type: "base64", data, media_type } }
  const scanAnthropic = (arr: unknown[], messageIndex: number, inToolResult: boolean): void => {
    for (let i = 0; i < arr.length; i++) {
      const block = arr[i] as { type?: unknown; source?: unknown; content?: unknown } | null;
      if (!block || typeof block !== "object") continue;
      if (block.type === "image") {
        const source = (block.source ?? {}) as { type?: unknown; data?: unknown; url?: unknown };
        const data = typeof source.data === "string" ? source.data : "";
        const url = typeof source.url === "string" ? source.url : "";
        push(arr, i, "anthropic", {
          ...(source.type === "base64" && data.length > 0 ? { data } : { url }),
        }, {
          messageIndex,
          turnIndex: userTurnIndex(messages, messageIndex),
          inToolResult,
        });
      } else if (block.type === "tool_result" && Array.isArray(block.content)) {
        scanAnthropic(block.content, messageIndex, true);
      }
    }
  };

  for (let m = 0; m < messages.length; m++) {
    const content = (messages[m] as { content?: unknown })?.content;
    if (Array.isArray(content)) scanAnthropic(content, m, false);
  }

  // Chat-completions shape: { type: "image_url", image_url: { url: "<data URL>" } }
  for (let m = 0; m < messages.length; m++) {
    const content = (messages[m] as { content?: unknown })?.content;
    if (!Array.isArray(content)) continue;
    for (let i = 0; i < content.length; i++) {
      const block = content[i] as { type?: unknown; image_url?: unknown } | null;
      if (!block || typeof block !== "object" || block.type !== "image_url") continue;
      const url = String((block.image_url as { url?: unknown })?.url ?? "");
      const data = base64OfDataUrl(url);
      push(content, i, "chat-completions", { ...(data ? { data } : { url }) }, {
        messageIndex: m,
        turnIndex: userTurnIndex(messages, m),
        inToolResult: false,
      });
    }
  }

  // Responses shape: { type: "input_image", image_url: "<data URL>" }
  const input = Array.isArray((body as { input?: unknown }).input)
    ? ((body as { input?: unknown }).input as unknown[])
    : [];
  for (let i = 0; i < input.length; i++) {
    const item = input[i] as { content?: unknown } | null;
    const content = item?.content;
    if (!Array.isArray(content)) continue;
    for (let j = 0; j < content.length; j++) {
      const block = content[j] as { type?: unknown; image_url?: unknown; url?: unknown } | null;
      if (!block || typeof block !== "object") continue;
      const type = String(block.type ?? "");
      if (type !== "input_image" && type !== "image") continue;
      const raw = String(block.image_url ?? block.url ?? "");
      const data = base64OfDataUrl(raw);
      push(content, j, "responses", { ...(data ? { data } : { url: raw }) }, {
        messageIndex: i,
        turnIndex: i,
        inToolResult: false,
      });
    }
  }

  return { entries, firstOccurrence };
}

/**
 * The user-turn index of a message.
 *
 * "How recent is this?" has to be measured in TURNS, not in messages: a turn is one user
 * message plus the assistant/tool turns it triggered, so two images one turn apart can sit
 * six message indices apart. Counting messages would make the "recent" window depend on
 * how many tool calls a turn happened to make.
 */
function userTurnIndex(messages: unknown[], messageIndex: number): number {
  let turn = 0;
  for (let i = 0; i <= messageIndex && i < messages.length; i++) {
    const role = (messages[i] as { role?: unknown })?.role;
    if (role === "user") turn++;
  }
  return Math.max(0, turn - 1);
}
