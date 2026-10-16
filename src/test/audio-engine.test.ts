import { afterEach, describe, expect, it, vi } from "vitest";
import { canDecode, Engine } from "@/lib/audio-engine";

describe("bounded audio decoding", () => {
  it("decodes a safe short file", () => expect(canDecode(100000, 6, 48000)).toBe(true));
  it("streams long compressed files despite small encoded size", () => expect(canDecode(1000000, 3600, 48000)).toBe(false));
  it("streams large files", () => expect(canDecode(50 * 1024 * 1024, 120, 48000)).toBe(false));
});

const param = () => ({ value: 1, cancelScheduledValues: vi.fn(), setValueAtTime: vi.fn(), setValueCurveAtTime: vi.fn(), linearRampToValueAtTime: vi.fn() });
class Context {
  state = "running";
  currentTime = 0;
  sampleRate = 48000;
  destination = {};
  createGain() { return { gain: param(), connect: vi.fn().mockReturnThis(), disconnect: vi.fn() }; }
  createMediaElementSource() { return { connect: vi.fn().mockReturnThis(), disconnect: vi.fn() }; }
  resume = vi.fn(async () => { this.state = "running"; });
  suspend = vi.fn(async () => { this.state = "suspended"; });
}
afterEach(() => vi.unstubAllGlobals());
describe("loading session cancellation", () => {
  it("stop cancels pending metadata and cannot restart zombie audio", async () => {
    vi.stubGlobal("AudioContext", Context);
    vi.stubGlobal("URL", { createObjectURL: vi.fn(() => "blob:test"), revokeObjectURL: vi.fn() });
    class Audio extends EventTarget {
      src = ""; preload = ""; readyState = 0; error = null;
      play = vi.fn(async () => {}); pause = vi.fn(); load = vi.fn(); removeAttribute = vi.fn();
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