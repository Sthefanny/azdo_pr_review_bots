import type { Logger } from "../utils/logger.js";

const GIPHY_RANDOM = "https://api.giphy.com/v1/gifs/random";

/** Tags biased toward celebration / appreciation (Giphy `tag` on `/random`). */
const CELEBRATION_TAGS = [
  "thank you celebration",
  "great job team",
  "celebration confetti",
  "applause well done",
  "high five awesome",
  "you rock amazing",
];

interface GiphyImages {
  downsized?: { url?: string };
  fixed_height?: { url?: string };
  original?: { url?: string };
}

interface GiphyRandomData {
  title?: string;
  images?: GiphyImages;
}

interface GiphyRandomJson {
  data?: GiphyRandomData;
  meta?: { status?: number; msg?: string };
}

function pickGifUrl(data: GiphyRandomData): string | null {
  const imgs = data.images;
  if (!imgs) return null;
  return (
    imgs.downsized?.url ??
    imgs.fixed_height?.url ??
    imgs.original?.url ??
    null
  );
}

/** Exposed for unit tests parsing a Giphy `/random` JSON body. */
export function celebrationGifFromRandomPayload(
  json: unknown,
): { imageUrl: string; altText: string } | null {
  const payload = json as GiphyRandomJson;
  const data = payload.data;
  if (!data) return null;
  const imageUrl = pickGifUrl(data);
  if (!imageUrl) return null;
  const rawTitle = (data.title ?? "Celebration").trim() || "Celebration animation";
  const altText = rawTitle.length > 2000 ? `${rawTitle.slice(0, 1997)}…` : rawTitle;
  return { imageUrl, altText };
}

/**
 * Random GIF suitable for thanking / celebrating the weekly top reviewer.
 * Uses Giphy “random” with a tag; `rating=g` (general).
 */
export async function fetchRandomCelebrationGif(params: {
  apiKey: string;
  logger: Logger;
}): Promise<{ imageUrl: string; altText: string } | null> {
  const tag =
    CELEBRATION_TAGS[Math.floor(Math.random() * CELEBRATION_TAGS.length)]!;
  const url = new URL(GIPHY_RANDOM);
  url.searchParams.set("api_key", params.apiKey.trim());
  url.searchParams.set("tag", tag);
  url.searchParams.set("rating", "g");

  try {
    const res = await fetch(url.toString());
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      params.logger.warn(`Giphy random failed ${res.status}: ${body.slice(0, 200)}`);
      return null;
    }
    const json = (await res.json()) as GiphyRandomJson;
    const parsed = celebrationGifFromRandomPayload(json);
    if (!parsed) {
      params.logger.warn(`Giphy random: empty or missing image (${json.meta?.msg ?? "unknown"})`);
      return null;
    }
    return parsed;
  } catch (err) {
    params.logger.warn("Giphy random request error", err);
    return null;
  }
}
