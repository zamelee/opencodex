import { describe, expect, test } from "bun:test";
import { createRequire } from "node:module";
import { downsampleImagePayload, loadSharp, resetSharpCache } from "../src/image/image-downsample";
import { enforceUpstreamPromptBudget } from "../src/lib/upstream-prompt-budget";
import {
  imageDownsampleSettings,
  resolveImageDownsampleEnabled,
  setGlobalImageDownsample,
  setModelImageDownsample,
  setProviderImageDownsample,
} from "../src/providers/image-downsample";
import type { OcxConfig } from "../src/types";

const require = createRequire(import.meta.url);

/** A real PNG, encoded by sharp, so the downsampler has actual pixels to work on. */
async function realPng(width: number, height: number): Promise<string> {
  const sharp = require("sharp") as (
    input: Buffer,
    opts?: { raw?: { width: number; height: number; channels: number } },
  ) => {
    raw: (opts: { width: number; height: number; channels: number }) => {
      png: () => { toBuffer: () => Promise<Buffer> };
    };
  };
  // A gradient: flat colour compresses too well to prove anything about size.
  const pixels = Buffer.alloc(width * height * 3);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 3;
      pixels[i] = x % 256;
      pixels[i + 1] = y % 256;
      pixels[i + 2] = (x + y) % 256;
    }
  }
  const buffer = await sharp(pixels, { raw: { width, height, channels: 3 } })
    .png()
    .toBuffer();
  return buffer.toString("base64");
}

describe("image downsampling (phase 2)", () => {
  test("sharp is loadable in this environment", () => {
    resetSharpCache();
    expect(loadSharp()).not.toBeNull();
  });

  test("scales a large image down and reports the new size", async () => {
    resetSharpCache();
    const data = await realPng(2400, 1800);
    const result = await downsampleImagePayload(data, "image/png", { maxEdge: 1200 });
    expect(result).not.toBeNull();
    expect(result!.width).toBeLessThanOrEqual(1200);
    expect(result!.height).toBeLessThanOrEqual(1200);
    expect(result!.width).toBe(1200);
    expect(result!.height).toBe(900);
    expect(result!.bytesAfter).toBeLessThan(result!.bytesBefore);
    expect(["image/png", "image/jpeg"]).toContain(result!.mediaType);
  });

  test("leaves an image that is already small enough alone", async () => {
    const data = await realPng(200, 150);
    const result = await downsampleImagePayload(data, "image/png", { maxEdge: 1200 });
    expect(result).toBeNull();
  });

  test("returns null for a payload it cannot decode", async () => {
    const result = await downsampleImagePayload("not-an-image", "image/png", { maxEdge: 1200 });
    expect(result).toBeNull();
  });
});

describe("the downsampling switch: global / provider / model", () => {
  const base = (): OcxConfig => ({}) as OcxConfig;

  test("is off by default", () => {
    expect(resolveImageDownsampleEnabled(base(), "m.aiio.chat", "gpt-x")).toBe(false);
  });

  test("the global default applies to everyone", () => {
    const config = base();
    setGlobalImageDownsample(config, true);
    expect(resolveImageDownsampleEnabled(config, "p1", "m1")).toBe(true);
  });

  test("a provider override beats the global default", () => {
    const config = base();
    setGlobalImageDownsample(config, true);
    setProviderImageDownsample(config, "p1", false);
    expect(resolveImageDownsampleEnabled(config, "p1", "m1")).toBe(false);
    expect(resolveImageDownsampleEnabled(config, "p2", "m1")).toBe(true);
  });

  test("a model override beats the provider override", () => {
    const config = base();
    setProviderImageDownsample(config, "p1", false);
    setModelImageDownsample(config, "p1/m1", true);
    expect(resolveImageDownsampleEnabled(config, "p1", "m1")).toBe(true);
    // A different model of the same provider keeps the provider's setting.
    expect(resolveImageDownsampleEnabled(config, "p1", "m2")).toBe(false);
  });

  test("the model override is also found when the model id is already namespaced", () => {
    const config = base();
    setModelImageDownsample(config, "p1/m1", true);
    expect(resolveImageDownsampleEnabled(config, "p1", "p1/m1")).toBe(true);
  });

  test("clearing an override falls back to the level below", () => {
    const config = base();
    setGlobalImageDownsample(config, true);
    setProviderImageDownsample(config, "p1", false);
    setModelImageDownsample(config, "p1/m1", null);
    expect(resolveImageDownsampleEnabled(config, "p1", "m1")).toBe(false);
    setProviderImageDownsample(config, "p1", null);
    expect(resolveImageDownsampleEnabled(config, "p1", "m1")).toBe(true);
  });

  test("the settings view mirrors what the resolver decides", () => {
    const config = base();
    setGlobalImageDownsample(config, true);
    setProviderImageDownsample(config, "p1", false);
    setModelImageDownsample(config, "p1/m1", true);
    const settings = imageDownsampleSettings(config);
    expect(settings.defaultEnabled).toBe(true);
    expect(settings.providers).toEqual({ p1: false });
    expect(settings.models).toEqual({ "p1/m1": true });
  });
});

describe("the brake with downsampling enabled", () => {
  function bodyWith(data: string): unknown {
    return {
      model: "m",
      max_tokens: 1024,
      messages: [{
        role: "user",
        content: [{ type: "image", source: { type: "base64", media_type: "image/png", data } }],
      }],
    };
  }

  test("shrinks the image instead of dropping it", async () => {
    resetSharpCache();
    const data = await realPng(3000, 2000);
    const body = bodyWith(data);
    // A budget that only a shrunken image can fit: 3000x2000 bills ~8000 vision tokens,
    // the 1568px-long-edge version bills ~3200.
    const result = await enforceUpstreamPromptBudget(body, 4_000, {
      providerName: "anthropic",
      modelId: "claude-x",
      imageDownsample: true,
    });
    expect(result.imageDownsamples.length).toBe(1);
    expect(result.droppedImages).toBe(0);
    const content = (result.body as { messages: Array<{ content: Array<{ type?: string; source?: { media_type?: string } }> }> })
      .messages[0].content;
    expect(content[0].type).toBe("image");
    expect(["image/png", "image/jpeg"]).toContain(content[0].source?.media_type);
  });

  test("with the switch off the image is dropped, not shrunk", async () => {
    const data = await realPng(3000, 2000);
    const body = bodyWith(data);
    const result = await enforceUpstreamPromptBudget(body, 4_000, {
      providerName: "anthropic",
      modelId: "claude-x",
    });
    expect(result.imageDownsamples.length).toBe(0);
    expect(result.droppedImages).toBe(1);
  });
});
