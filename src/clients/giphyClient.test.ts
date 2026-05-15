import { describe, expect, it } from "vitest";

import { celebrationGifFromRandomPayload } from "./giphyClient.js";

describe("celebrationGifFromRandomPayload", () => {
  it("prefers downsized URL and title", () => {
    const out = celebrationGifFromRandomPayload({
      data: {
        title: "Party GIF",
        images: {
          downsized: { url: "https://media.giphy.com/ds.gif" },
          original: { url: "https://media.giphy.com/huge.gif" },
        },
      },
    });
    expect(out).toEqual({
      imageUrl: "https://media.giphy.com/ds.gif",
      altText: "Party GIF",
    });
  });

  it("falls back to fixed_height then original", () => {
    const out = celebrationGifFromRandomPayload({
      data: {
        images: {
          fixed_height: { url: "https://media.giphy.com/fh.gif" },
        },
      },
    });
    expect(out?.imageUrl).toBe("https://media.giphy.com/fh.gif");
  });

  it("returns null when no image URL", () => {
    expect(celebrationGifFromRandomPayload({ data: { title: "x" } })).toBeNull();
  });
});
