import { describe, expect, it, vi } from "vitest";
import { parseYouTube } from "@/lib/youtube";
import { crossfadeFor, CROSSFADE, Engine } from "@/lib/audio-engine";

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

describe("YouTubeEngine loop and controls", () => {
  it("configures loop parameter and loops video on ENDED event", async () => {
    let capturedOpts:
      | {
          playerVars: { loop: number; playlist: string };
          events: {
            onStateChange: (e: {
              data: number;
              target: { seekTo: (s: number, b: boolean) => void; playVideo: () => void };
            }) => void;
          };
        }
      | undefined;

    const mockYT = {
      Player: class {
        constructor(_el: HTMLElement, opts: typeof capturedOpts) {
          capturedOpts = opts;
        }
      },
      PlayerState: { ENDED: 0, PLAYING: 1, PAUSED: 2, BUFFERING: 3, CUED: 5 },
    };

    const prevYT = (window as unknown as { YT?: unknown }).YT;
    (window as unknown as { YT?: unknown }).YT = mockYT;

    const container = document.createElement("div");
    document.body.appendChild(container);

    const { youtubeEngine } = await import("@/lib/youtube-engine");
    await youtubeEngine.mount(container, "dQw4w9WgXcQ", "Test Video");

    expect(capturedOpts).toBeDefined();
    expect(capturedOpts?.playerVars.loop).toBe(1);
    expect(capturedOpts?.playerVars.playlist).toBe("dQw4w9WgXcQ");

    const target = { seekTo: vi.fn(), playVideo: vi.fn() };
    capturedOpts?.events.onStateChange({ data: 0, target }); // ENDED
    expect(target.seekTo).toHaveBeenCalledWith(0, true);
    expect(target.playVideo).toHaveBeenCalled();

    youtubeEngine.destroy();
    expect(container.innerHTML).toBe("");
    container.remove();
    (window as unknown as { YT?: unknown }).YT = prevYT;
  });
});

describe("MediaSession Android notification artwork", () => {
  it("specifies multiple standard sizes and handles jpeg artwork for notification shade", () => {
    let capturedMetadata:
      { title: string; artwork: Array<{ src: string; sizes: string; type: string }> } | undefined;
    const mockMediaSession = {
      metadata: null,
      playbackState: "none",
      setActionHandler: vi.fn(),
      setPositionState: vi.fn(),
    };
    vi.stubGlobal("navigator", { mediaSession: mockMediaSession });
    vi.stubGlobal(
      "MediaMetadata",
      class {
        title: string;
        artwork: Array<{ src: string; sizes: string; type: string }>;
        constructor(opts: {
          title: string;
          artwork: Array<{ src: string; sizes: string; type: string }>;
        }) {
          this.title = opts.title;
          this.artwork = opts.artwork;
          capturedMetadata = { title: opts.title, artwork: opts.artwork };
        }
      },
    );

    const testEngine = new Engine();
    const coverBlob = new Blob(["fake-image"], { type: "image/jpeg" });
    testEngine.setMetadata({ title: "Forest Sounds", coverBlob });

    expect(capturedMetadata).toBeDefined();
    expect(capturedMetadata?.title).toBe("Forest Sounds");
    expect(capturedMetadata?.artwork.length).toBeGreaterThanOrEqual(6);
    expect(capturedMetadata?.artwork.some((a) => a.sizes === "512x512")).toBe(true);
    expect(capturedMetadata?.artwork.some((a) => a.sizes === "192x192")).toBe(true);
    expect(capturedMetadata?.artwork.every((a) => a.type === "image/jpeg")).toBe(true);

    testEngine.stop();
  });
});
