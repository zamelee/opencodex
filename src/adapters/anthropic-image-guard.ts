/**
 * Anthropic per-request image limits (docs.anthropic.com Vision, verified 2026-07-06):
 * - <= 20 images: each image may be up to 8000px on a side.
 * - > 20 images ("many-image request"): each image is capped at 2000px per side;
 *   one offender 400s the whole request:
 *   "At least one of the image dimensions exceed max allowed size for many-image requests: 2000 pixels"
 * - Hard cap: 100 images per request.
 *
 * Codex threads accumulate screenshots in history, so long sessions cross 20 images
 * easily and any single retina capture (>2000px wide) kills every later turn. Bun has
 * no native resizer and we do not want a decoder dependency, so instead of downscaling
 * we keep the request under the 20-image threshold (restoring the 8000px allowance) by
 * textifying the OLDEST image blocks. Newest screenshots are the ones the model needs.
 */

export const MANY_IMAGE_THRESHOLD = 20;
export const MANY_IMAGE_MAX_DIMENSION = 2000;
export const ABSOLUTE_MAX_DIMENSION = 8000;
export const MAX_IMAGES_PER_REQUEST = 100;

/**
 * Preflight budget for base64 that would be billed as TEXT.
 *
 * Screenshots arrive as base64 data URLs. When they ride as native image
 * blocks they cost vision tokens (11 real screenshots = 4.59MB base64 =
 * 33K tokens). But when base64 ends up inside a TEXT block — a tool result
 * that cannot be paired with its tool_use, or a payload that arrives
 * JSON-encoded as a string — upstream counts ~1.4 chars/token, so the same
 * 4.59MB becomes a ~3.28M-token prompt and the request 400s with
 * "prompt is too long" (observed: 3,393,866 tokens > 1,048,576 maximum).
 *
 * So this rule finds base64 data URLs that leaked into text blocks and strips
 * the payload, leaving a marker. Native image blocks are untouched — they are
 * not the billing hazard. The upstream symptom is a 400 that kills the whole
 * turn, so losing a screenshot is strictly better than losing the turn.
 */
export const MAX_BASE64_TEXT_CHARS = 2_000_000;
/** A data URL embedded in a text block, e.g. `data:image/png;base64,AAAA...`. */
const DATA_URL_IN_TEXT = /data:[a-z0-9.+-]+\/[a-z0-9.+-]+;base64,[A-Za-z0-9+/=]+/gi;

const STRIPPED_TEXT = "[image omitted: base64 payload stripped from text to stay within the context budget]";

const OMITTED_TEXT = "[image omitted: Anthropic request exceeded the 20-image limit for large images; older screenshots were dropped]";
const OVERSIZED_TEXT = "[image omitted: exceeds Anthropic's 8000px per-side limit]";

interface ImageDimensions { width: number; height: number }

/** Read big-endian u16/u32 helpers over a byte array. */
function u16be(b: Uint8Array, o: number): number { return (b[o] << 8) | b[o + 1]; }
function u32be(b: Uint8Array, o: number): number { return ((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0; }
function u16le(b: Uint8Array, o: number): number { return b[o] | (b[o + 1] << 8); }
function u24le(b: Uint8Array, o: number): number { return b[o] | (b[o + 1] << 8) | (b[o + 2] << 16); }

function pngDimensions(b: Uint8Array): ImageDimensions | null {
  // 8-byte signature + IHDR chunk (len+type at 8..16, data at 16).
  if (b.length < 24) return null;
  if (b[0] !== 0x89 || b[1] !== 0x50 || b[2] !== 0x4e || b[3] !== 0x47) return null;
  return { width: u32be(b, 16), height: u32be(b, 20) };
}

function jpegDimensions(b: Uint8Array): ImageDimensions | null {
  if (b.length < 4 || b[0] !== 0xff || b[1] !== 0xd8) return null;
  let o = 2;
  while (o + 9 < b.length) {
    if (b[o] !== 0xff) { o++; continue; }
    const marker = b[o + 1];
    // Skip padding/fill bytes and standalone markers (RSTn, TEM) which have no length.
    if (marker === 0xff) { o++; continue; }
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { o += 2; continue; }
    // SOF0-SOF15 carry dimensions, excluding DHT(0xc4)/JPG(0xc8)/DAC(0xcc).
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      return { height: u16be(b, o + 5), width: u16be(b, o + 7) };
    }
    if (marker === 0xd9 || marker === 0xda) return null; // EOI / start of scan: no SOF found
    const len = u16be(b, o + 2);
    if (len < 2) return null;
    o += 2 + len;
  }
  return null;
}

function gifDimensions(b: Uint8Array): ImageDimensions | null {
  if (b.length < 10) return null;
  if (b[0] !== 0x47 || b[1] !== 0x49 || b[2] !== 0x46) return null;
  return { width: u16le(b, 6), height: u16le(b, 8) };
}

function webpDimensions(b: Uint8Array): ImageDimensions | null {
  if (b.length < 30) return null;
  if (b[0] !== 0x52 || b[1] !== 0x49 || b[2] !== 0x46 || b[3] !== 0x46) return null; // RIFF
  if (b[8] !== 0x57 || b[9] !== 0x45 || b[10] !== 0x42 || b[11] !== 0x50) return null; // WEBP
  const fourcc = String.fromCharCode(b[12], b[13], b[14], b[15]);
  if (fourcc === "VP8X") {
    return { width: u24le(b, 24) + 1, height: u24le(b, 27) + 1 };
  }
  if (fourcc === "VP8 ") {
    // Lossy: frame tag at 20, sync code 9d 01 2a, then 14-bit width/height.
    if (b[23] !== 0x9d || b[24] !== 0x01 || b[25] !== 0x2a) return null;
    return { width: u16le(b, 26) & 0x3fff, height: u16le(b, 28) & 0x3fff };
  }
  if (fourcc === "VP8L") {
    if (b[20] !== 0x2f) return null;
    // VP8L stores 14-bit width-1 / height-1 little-endian-bit-packed.
    const raw = b[21] | (b[22] << 8) | (b[23] << 16) | (b[24] << 24);
    const width = (raw & 0x3fff) + 1;
    const height = ((raw >> 14) & 0x3fff) + 1;
    return { width, height };
  }
  return null;
}

/**
 * Sniff pixel dimensions from the first bytes of a base64 image. Returns null when the
 * format is unrecognized or the header is malformed — callers must treat null as
 * "unknown, assume within limits" so we never drop an image we cannot prove oversized.
 */
export function sniffImageDimensions(base64: string): ImageDimensions | null {
  // ~48KB of decoded header is enough for every sniffer above, including JPEGs whose
  // SOF sits behind large EXIF/APPn segments (segments are skipped by length).
  const slice = base64.slice(0, 65536);
  let bytes: Uint8Array;
  try {
    bytes = Uint8Array.from(atob(slice.length % 4 === 0 ? slice : slice.slice(0, slice.length - (slice.length % 4))), c => c.charCodeAt(0));
  } catch {
    return null;
  }
  return pngDimensions(bytes) ?? jpegDimensions(bytes) ?? gifDimensions(bytes) ?? webpDimensions(bytes) ?? null;
}

interface ImageBlockRef {
  /** The array holding the block (message content or tool_result content). */
  container: unknown[];
  index: number;
  base64: string | null;
}

function isImageBlock(block: unknown): block is { type: "image"; source: Record<string, unknown> } {
  return typeof block === "object" && block !== null && (block as { type?: unknown }).type === "image";
}

/** Collect refs to every image block in wire order (oldest first), descending into tool_result content. */
function collectImageRefs(messages: unknown[]): ImageBlockRef[] {
  const refs: ImageBlockRef[] = [];
  const scanArray = (arr: unknown[]): void => {
    for (let i = 0; i < arr.length; i++) {
      const block = arr[i];
      if (isImageBlock(block)) {
        const source = block.source as { type?: unknown; data?: unknown };
        refs.push({
          container: arr,
          index: i,
          base64: source?.type === "base64" && typeof source.data === "string" ? source.data : null,
        });
      } else if (typeof block === "object" && block !== null && (block as { type?: unknown }).type === "tool_result") {
        const content = (block as { content?: unknown }).content;
        if (Array.isArray(content)) scanArray(content);
      }
    }
  };
  for (const msg of messages) {
    const content = (msg as { content?: unknown })?.content;
    if (Array.isArray(content)) scanArray(content);
  }
  return refs;
}

function textify(ref: ImageBlockRef, text: string): void {
  ref.container[ref.index] = { type: "text", text };
}

/**
 * Enforce Anthropic image limits on already-built wire messages (mutates in place).
 * Policy: unconditionally textify >8000px images; when the request would be a
 * many-image request (>20) with at least one image over 2000px, textify oldest
 * images until <=20 so the 8000px allowance applies; always cap at 100 images.
 */
export function enforceAnthropicImageLimits(messages: unknown[]): void {

  // Rule 0 (always runs): strip base64 payloads that leaked into TEXT blocks.
  // This is the shape upstream bills as text (~1.4 chars/token), and it is
  // reachable with zero image blocks (a tool result whose payload arrived as a
  // JSON string), so it must not sit behind the image-block early return.
  stripBase64FromText(messages);

  const refs = collectImageRefs(messages);
  if (refs.length === 0) return;

  const dims = refs.map(r => (r.base64 ? sniffImageDimensions(r.base64) : null));
  const live = new Set<number>(refs.keys());

  // Rule 1: images over the absolute 8000px cap are invalid in any request.
  for (let i = 0; i < refs.length; i++) {
    const d = dims[i];
    if (d && (d.width > ABSOLUTE_MAX_DIMENSION || d.height > ABSOLUTE_MAX_DIMENSION)) {
      textify(refs[i], OVERSIZED_TEXT);
      live.delete(i);
    }
  }

  // Rule 2: many-image requests cap each image at 2000px. Keep the request at <=20
  // images (dropping oldest first) whenever a surviving image exceeds that cap OR has
  // unknown dimensions (URL sources and unsniffable formats): one unverifiable offender
  // 400s the whole request upstream, so unknown counts as risky, not as safe.
  const hasRiskyForMany = [...live].some(i => {
    const d = dims[i];
    return d === null || d.width > MANY_IMAGE_MAX_DIMENSION || d.height > MANY_IMAGE_MAX_DIMENSION;
  });
  if (hasRiskyForMany && live.size > MANY_IMAGE_THRESHOLD) {
    for (const i of [...live]) {
      if (live.size <= MANY_IMAGE_THRESHOLD) break;
      textify(refs[i], OMITTED_TEXT);
      live.delete(i);
    }
  }

  // Rule 3: hard cap of 100 images per request regardless of size.
  if (live.size > MAX_IMAGES_PER_REQUEST) {
    for (const i of [...live]) {
      if (live.size <= MAX_IMAGES_PER_REQUEST) break;
      textify(refs[i], OMITTED_TEXT);
      live.delete(i);
    }
  }

}

/**
 * Remove base64 data URLs from text blocks, keeping a marker in their place.
 *
 * Walks message content and `tool_result` content (the two places a text
 * block can carry a leaked data URL), replacing each match with a short
 * marker. Returns the number of stripped payloads.
 */
export function stripBase64FromText(messages: unknown[]): number {
  let stripped = 0;

  const stripText = (text: string): string =>
    text.replace(DATA_URL_IN_TEXT, () => { stripped++; return STRIPPED_TEXT; });

  const walk = (arr: unknown[]): void => {
    for (let i = 0; i < arr.length; i++) {
      const block = arr[i];
      if (typeof block !== "object" || block === null) continue;
      const b = block as { type?: unknown; text?: unknown; content?: unknown };
      if (b.type === "text" && typeof b.text === "string" && b.text.includes("base64,")) {
        arr[i] = { type: "text", text: stripText(b.text) };
      } else if (b.type === "tool_result" && Array.isArray(b.content)) {
        walk(b.content);
      } else if (b.type === "tool_result" && typeof b.content === "string" && b.content.includes("base64,")) {
        // A tool_result whose content is a plain string still carries the
        // payload as text — the same billing hazard.
        (b as { content: string }).content = stripText(b.content);
      }
    }
  };
  for (const msg of messages) {
    const content = (msg as { content?: unknown })?.content;
    if (Array.isArray(content)) walk(content);
    else if (typeof content === "string" && content.includes("base64,")) {
      (msg as { content: string }).content = stripText(content);
    }
  }
  return stripped;
}
