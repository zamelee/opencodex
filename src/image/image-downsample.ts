/**
 * True image downsampling (phase 2 of the image policy).
 *
 * WHY: phase 1 could only GIVE UP an image (replace it with a text placeholder). That is
 * the worst possible outcome for a request that carries a screenshot of the bug the user
 * is chasing - the model loses the very thing it was asked to look at. But the upstream
 * bills vision by PIXELS, so a 4000x3000 screenshot costs ~10x a 1000x760 one. Between
 * "full size" and "gone" there is a third option that phase 1 never had: SHRINK it.
 *
 * WHAT: decode the payload, scale the long edge down to the provider's standard image
 * limit, re-encode, and put the smaller bytes back on the wire. The model still sees the
 * picture; it just sees a smaller one.
 *
 * The decoder is `sharp` (already a dependency - no new package). It is loaded lazily
 * and behind a switch: an operator who wants byte-exact prompts must be able to turn
 * this OFF and get phase 1's behaviour unchanged.
 */

import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

/** Minimal shape of the `sharp` factory we use. */
type SharpFactory = (
  input: Buffer,
) => {
  metadata: () => Promise<{ width?: number; height?: number; format?: string }>;
  resize: (opts: {
    width: number;
    height: number;
    fit: "inside";
    withoutEnlargement: boolean;
  }) => {
    toFormat: (fmt: "png" | "jpeg") => {
      toBuffer: () => Promise<Buffer>;
    };
    jpeg: (opts: { quality: number }) => {
      toBuffer: () => Promise<Buffer>;
    };
  };
};

let sharpCache: SharpFactory | null | undefined;

/**
 * Load `sharp` once, lazily.
 *
 * `null` means "not available" - a missing native binary must degrade to phase 1
 * (dropping), never break the request.
 */
export function loadSharp(): SharpFactory | null {
  if (sharpCache === undefined) {
    try {
      const mod = require("sharp") as unknown;
      const factory = typeof mod === "function"
        ? mod
        : (mod as { default?: unknown }).default;
      sharpCache = typeof factory === "function" ? (factory as SharpFactory) : null;
    } catch {
      sharpCache = null;
    }
  }
  return sharpCache;
}

/** Test seam: forget the cached loader result. */
export function resetSharpCache(): void {
  sharpCache = undefined;
}

export interface DownsampleOptions {
  /** Target long edge in pixels. Images already at or below this are left alone. */
  maxEdge: number;
  /** JPEG quality used for the lossy candidate. */
  jpegQuality?: number;
}

export interface DownsampleResult {
  /** The new base64 payload (no data-URL prefix). */
  data: string;
  /** The mime type of the new payload ("image/png" / "image/jpeg"). */
  mediaType: string;
  width: number;
  height: number;
  /** Size of the original payload in bytes (decoded). */
  bytesBefore: number;
  /** Size of the new payload in bytes (decoded). */
  bytesAfter: number;
}

/**
 * PNG is preferred when it is not much bigger than the JPEG: a flat screenshot keeps
 * its text crisp in PNG, while a photo's PNG is enormous and the JPEG wins by miles.
 */
const PNG_ACCEPTANCE_RATIO = 1.2;

/**
 * Scale one image payload down.
 *
 * Returns null when nothing should be done: the image is already small enough, the
 * payload cannot be decoded, or `sharp` is unavailable. The caller then falls back to
 * the phase-1 policy (drop by value).
 */
export async function downsampleImagePayload(
  data: string,
  mediaType: string,
  options: DownsampleOptions,
): Promise<DownsampleResult | null> {
  const sharp = loadSharp();
  if (!sharp) return null;
  const maxEdge = Math.max(64, Math.floor(options.maxEdge));
  let input: Buffer;
  try {
    input = Buffer.from(data, "base64");
  } catch {
    return null;
  }
  if (input.length === 0) return null;

  let meta: { width?: number; height?: number; format?: string };
  try {
    meta = await sharp(input).metadata();
  } catch {
    return null;
  }
  const width = meta.width ?? 0;
  const height = meta.height ?? 0;
  if (width <= 0 || height <= 0) return null;
  const longEdge = Math.max(width, height);
  if (longEdge <= maxEdge) return null;

  // Preserve the aspect ratio: scale both edges by the same factor.
  const scale = maxEdge / longEdge;
  const targetWidth = Math.max(1, Math.round(width * scale));
  const targetHeight = Math.max(1, Math.round(height * scale));

  let png: Buffer | null = null;
  let jpeg: Buffer | null = null;
  try {
    png = await sharp(input)
      .resize({ width: targetWidth, height: targetHeight, fit: "inside", withoutEnlargement: true })
      .toFormat("png")
      .toBuffer();
  } catch {
    png = null;
  }
  try {
    jpeg = await sharp(input)
      .resize({ width: targetWidth, height: targetHeight, fit: "inside", withoutEnlargement: true })
      .jpeg({ quality: options.jpegQuality ?? 82 })
      .toBuffer();
  } catch {
    jpeg = null;
  }

  let chosen: Buffer | null = null;
  let chosenType = "image/png";
  if (png && jpeg) {
    if (png.length <= jpeg.length * PNG_ACCEPTANCE_RATIO) {
      chosen = png;
      chosenType = "image/png";
    } else {
      chosen = jpeg;
      chosenType = "image/jpeg";
    }
  } else if (png) {
    chosen = png;
    chosenType = "image/png";
  } else if (jpeg) {
    chosen = jpeg;
    chosenType = "image/jpeg";
  }
  if (!chosen) return null;
  // A "downsample" that made the payload bigger is not a downsample.
  if (chosen.length >= input.length && mediaType === chosenType) return null;

  return {
    data: chosen.toString("base64"),
    mediaType: chosenType,
    width: targetWidth,
    height: targetHeight,
    bytesBefore: input.length,
    bytesAfter: chosen.length,
  };
}
