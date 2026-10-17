import { afterEach, describe, expect, it, vi } from "vitest";
import { canDecode, crossfadeFor, Engine, CROSSFADE, renderLoopBuffer } from "@/lib/audio-engine";

describe("bounded audio decoding", () => {
  it("decodes a safe short file", () => expect(canDecode(100000, 6, 48000)).toBe(true));
  it("streams long compressed files despite small encoded size", () =>
    expect(canDecode(1000000, 3600, 48000)).toBe(false));
  it("streams large files", () => expect(canDecode(50 * 1024 * 1024, 120, 48000)).toBe(false));
});

describe("crossfade calculations", () => {
  it("caps crossfade at CROSSFADE for long ambient tracks", () => {
    expect(crossfadeFor(30)).toBe(CROSSFADE);
    expect(crossfadeFor(120)).toBe(CROSSFADE);
  });

  it("scales crossfade down smoothly for short clips", () => {
    expect(crossfadeFor(2)).toBeCloseTo(0.8);
    expect(crossfadeFor(5)).toBe(2.0);
  });

  it("handles non-finite or zero duration gracefully", () => {
    expect(crossfadeFor(0)).toBe(0);
    expect(crossfadeFor(-5)).toBe(0);
    expect(crossfadeFor(NaN)).toBe(0);
  });
});

const param = () => ({
  value: 1,
  cancelScheduledValues: vi.fn(),
  setValueAtTime: vi.fn(),
  setValueCurveAtTime: vi.fn(),
  linearRampToValueAtTime: vi.fn(),
});

class Context {
  state = "running";
  currentTime = 0;
  sampleRate = 48000;
  destination = {};
  createGain() {
    return { gain: param(), connect: vi.fn().mockReturnThis(), disconnect: vi.fn() };
  }
  createMediaElementSource() {
    return { connect: vi.fn().mockReturnThis(), disconnect: vi.fn() };
  }
  createBufferSource() {
    return {
      buffer: null,
      connect: vi.fn().mockReturnThis(),
      disconnect: vi.fn(),
      start: vi.fn(),
      stop: vi.fn(),
    };
  }
  decodeAudioData = vi.fn(async () => ({
    duration: 10,
    numberOfChannels: 2,
    sampleRate: 48000,
  }));
  resume = vi.fn(async () => {
    this.state = "running";
  });
  suspend = vi.fn(async () => {
    this.state = "suspended";
  });
}

afterEach(() => vi.unstubAllGlobals());

describe("loading session cancellation", () => {
  it("stop cancels pending metadata and cannot restart zombie audio", async () => {
    vi.stubGlobal("AudioContext", Context);
    vi.stubGlobal("URL", { createObjectURL: vi.fn(() => "blob:test"), revokeObjectURL: vi.fn() });
    class Audio extends EventTarget {
      src = "";
      preload = "";
      readyState = 0;
      error = null;
      play = vi.fn(async () => {});
      pause = vi.fn();
      load = vi.fn();
      removeAttribute = vi.fn();
    }
    vi.stubGlobal("Audio", Audio);
    const engine = new Engine();
    const pending = engine.start("test", new Blob(["audio"]));
    expect(engine.state.status).toBe("loading");
    engine.stop();
    await pending;
    expect(engine.state).toEqual({ status: "idle", itemId: null, error: undefined });
    expect(engine.voiceCount).toBe(0);
    expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:test");
  });
});

describe("playback lifecycle and state synchronization", () => {
  it("resets state and position on stop()", () => {
    vi.stubGlobal("AudioContext", Context);
    const engine = new Engine();
    engine.stop();
    expect(engine.state.status).toBe("idle");
    expect(engine.state.itemId).toBeNull();
    expect(engine.position).toBe(0);
  });

  it("notifies subscribers when state changes", () => {
    vi.stubGlobal("AudioContext", Context);
    const engine = new Engine();
    const states: string[] = [];
    const unsubscribe = engine.subscribe((s) => states.push(s.status));
    engine.stop();
    unsubscribe();
    expect(states).toContain("idle");
  });

  it("handles MediaSession metadata updates safely", () => {
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
        constructor(opts: { title: string }) {
          this.title = opts.title;
        }
      },
    );

    const engine = new Engine();
    engine.setMetadata({ title: "Rain on Window" });

    expect(mockMediaSession.setActionHandler).toHaveBeenCalledWith("play", expect.any(Function));
    expect(mockMediaSession.setActionHandler).toHaveBeenCalledWith("pause", expect.any(Function));
    expect(mockMediaSession.setActionHandler).toHaveBeenCalledWith("stop", expect.any(Function));
  });
});

describe("renderLoopBuffer", () => {
  it("preserves total song length and applies fade effect only at the beginning and end", () => {
    const numSamples = 1000;
    const sampleRate = 100;
    const channels = 1;
    const data = new Float32Array(numSamples).fill(1.0);
    const mockBuffer = {
      duration: 10,
      length: numSamples,
      sampleRate,
      numberOfChannels: channels,
      getChannelData: () => data,
    } as unknown as AudioBuffer;

    const mockCtx = {
      createBuffer: (_c: number, len: number, sr: number) => {
        const out = new Float32Array(len);
        return {
          duration: len / sr,
          length: len,
          sampleRate: sr,
          numberOfChannels: 1,
          getChannelData: () => out,
        };
      },
    } as unknown as AudioContext;

    const rendered = renderLoopBuffer(mockCtx, mockBuffer);
    expect(rendered.length).toBe(mockBuffer.length);

    const outData = rendered.getChannelData(0);
    // Beginning: smooth fade-in starting at 0
    expect(outData[0]).toBeCloseTo(0, 2);
    expect(outData[50]).toBeGreaterThan(outData[0]);

    // Middle: standard normal song playback (1.0 unmodified)
    const mid = Math.floor(numSamples / 2);
    expect(outData[mid]).toBeCloseTo(1.0, 2);

    // End: smooth fade-out ending at 0
    expect(outData[numSamples - 1]).toBeCloseTo(0, 2);
  });
});
