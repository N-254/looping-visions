import { describe, expect, it } from "vitest";
import { parseYouTube } from "@/lib/youtube";
import { crossfadeFor, CROSSFADE } from "@/lib/audio-engine";

describe("YouTube links", () => {
  it("accepts watch and youtu.be links", () => {
    expect(parseYouTube("https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=3")).toBe("dQw4w9WgXcQ");
    expect(parseYouTube("https://youtu.be/dQw4w9WgXcQ?si=x")).toBe("dQw4w9WgXcQ");
    expect(parseYouTube("https://m.youtube.com/shorts/dQw4w9WgXcQ")).toBe("dQw4w9WgXcQ");
  });
  it("rejects unrelated or malformed links", () => {
    expect(parseYouTube("https://vimeo.com/watch?v=dQw4w9WgXcQ")).toBeNull();
    expect(parseYouTube("https://youtube.com/watch?v=short")).toBeNull();
    expect(parseYouTube("not a url")).toBeNull();
  });
});

describe("crossfade length", () => {
  it("uses the default for long clips", () => expect(crossfadeFor(120)).toBe(CROSSFADE));
  it("shrinks for clips shorter than the crossfade", () =>
    expect(crossfadeFor(2)).toBeCloseTo(0.8));
});
