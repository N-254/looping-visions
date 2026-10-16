/**
 * Single shared looping engine for local audio files.
 * - Files <= MAX_DECODE bytes are decoded once into an AudioBuffer and looped by
 *   scheduling overlapping AudioBufferSourceNodes with equal-power crossfades.
 * - Larger files use two media elements routed through gain nodes (no full decode).
 * Output is routed to a MediaStream played by a hidden <audio> element so Chrome
 * treats it as real media (Media Session notification + background playback).
 */
export type Status = "idle" | "loading" | "playing" | "paused" | "error";
export interface EngineState {
  status: Status;
  itemId: string | null;
  error?: string;
}

export const CROSSFADE = 3; // seconds (internal)
const MAX_DECODE = 40 * 1024 * 1024;
const LOOKAHEAD = 90; // seconds scheduled ahead, survives background timer throttling

export function crossfadeFor(duration: number) {
  return Math.max(0, Math.min(CROSSFADE, duration * 0.4));
}

function curve(up: boolean) {
  const n = 64;
  const c = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const x = i / (n - 1);
    c[i] = up ? Math.sin((x * Math.PI) / 2) : Math.cos((x * Math.PI) / 2);
  }
  return c;
}
const UP = curve(true);
const DOWN = curve(false);

type Voice = { src: AudioBufferSourceNode; g: GainNode };

class Engine {
  state: EngineState = { status: "idle", itemId: null };
  private listeners = new Set<(s: EngineState) => void>();
  private ctx?: AudioContext;
  private master?: GainNode;
  private out?: HTMLAudioElement;
  private token = 0;
  private voices = new Set<Voice>();
  private nextStart = 0;
  private buffer?: AudioBuffer;
  private timer?: ReturnType<typeof setTimeout>;
  private els: { el: HTMLAudioElement; node: MediaElementAudioSourceNode; g: GainNode }[] = [];
  private elUrl?: string;
  private active = 0;
  private fading = false;

  subscribe(fn: (s: EngineState) => void) {
    this.listeners.add(fn);
    fn(this.state);
    return () => void this.listeners.delete(fn);
  }
  private set(s: Partial<EngineState>) {
    this.state = { ...this.state, ...s };
    this.listeners.forEach((l) => l(this.state));
    if (navigator.mediaSession)
      navigator.mediaSession.playbackState =
        this.state.status === "playing" ? "playing" : this.state.status === "paused" ? "paused" : "none";
  }

  private ensure() {
    if (this.ctx) return this.ctx;
    const ctx = new AudioContext();
    this.master = ctx.createGain();
    if ("createMediaStreamDestination" in ctx) {
      const dest = ctx.createMediaStreamDestination();
      this.master.connect(dest);
      this.out = new Audio();
      this.out.srcObject = dest.stream;
      // OS / headset interruptions pause the element; mirror that as a real pause.
      this.out.addEventListener("pause", () => {
        if (this.state.status === "playing") this.pause();
      });
    } else this.master.connect(ctx.destination);
    this.ctx = ctx;
    return ctx;
  }

  /** Must be called from a user gesture. */
  async start(itemId: string, blob: Blob) {
    const token = ++this.token;
    this.teardown();
    const ctx = this.ensure();
    // Unlock inside the gesture, before any await.
    void ctx.resume();
    void this.out?.play().catch(() => {});
    this.set({ status: "loading", itemId, error: undefined });
    try {
      if (blob.size <= MAX_DECODE) {
        const buf = await ctx.decodeAudioData(await blob.arrayBuffer());
        if (token !== this.token) return;
        this.buffer = buf;
        this.startBuffer();
      } else {
        await this.startElements(blob, token);
        if (token !== this.token) return;
      }
      await ctx.resume();
      this.fadeMasterIn();
      this.set({ status: ctx.state === "running" ? "playing" : "paused" });
    } catch {
      if (token !== this.token) return;
      this.teardown();
      this.set({ status: "error", error: "This audio can't be played." });
    }
  }

  private fadeMasterIn() {
    const ctx = this.ctx!;
    const g = this.master!.gain;
    g.cancelScheduledValues(ctx.currentTime);
    g.setValueAtTime(0, ctx.currentTime);
    g.linearRampToValueAtTime(1, ctx.currentTime + 0.4);
  }

  // ---- buffer mode ----
  private startBuffer() {
    const ctx = this.ctx!;
    const buf = this.buffer!;
    if (buf.duration < 0.5) {
      // Too short to crossfade meaningfully: sample-accurate native loop.
      const src = ctx.createBufferSource();
      src.buffer = buf;
      src.loop = true;
      const g = ctx.createGain();
      src.connect(g).connect(this.master!);
      src.start();
      this.voices.add({ src, g });
      return;
    }
    this.nextStart = ctx.currentTime + 0.05;
    this.scheduleVoice(false);
    this.pump();
  }

  private scheduleVoice(fadeIn: boolean) {
    const ctx = this.ctx!;
    const buf = this.buffer!;
    const D = buf.duration;
    const X = crossfadeFor(D);
    const start = this.nextStart;
    const src = ctx.createBufferSource();
    src.buffer = buf;
    const g = ctx.createGain();
    src.connect(g).connect(this.master!);
    if (fadeIn) {
      g.gain.setValueAtTime(0, start);
      g.gain.setValueCurveAtTime(UP, start, X);
    } else g.gain.setValueAtTime(1, start);
    g.gain.setValueCurveAtTime(DOWN, start + D - X, X);
    src.start(start);
    src.stop(start + D);
    const v = { src, g };
    this.voices.add(v);
    src.onended = () => {
      src.disconnect();
      g.disconnect();
      this.voices.delete(v);
    };
    this.nextStart = start + D - X;
  }

  private pump = () => {
    if (!this.ctx || !this.buffer) return;
    while (this.nextStart < this.ctx.currentTime + LOOKAHEAD) this.scheduleVoice(true);
    this.timer = setTimeout(this.pump, 20000);
  };

  // ---- element mode (large files) ----
  private async startElements(blob: Blob, token: number) {
    const ctx = this.ctx!;
    this.elUrl = URL.createObjectURL(blob);
    for (let i = 0; i < 2; i++) {
      const el = new Audio(this.elUrl);
      el.preload = "auto";
      const node = ctx.createMediaElementSource(el);
      const g = ctx.createGain();
      g.gain.value = i === 0 ? 1 : 0;
      node.connect(g).connect(this.master!);
      el.onended = () => this.swap(true);
      this.els.push({ el, node, g });
    }
    const first = this.els[0].el;
    await new Promise<void>((res, rej) => {
      first.oncanplay = () => res();
      first.onerror = () => rej(new Error("decode"));
    });
    if (token !== this.token) return;
    this.active = 0;
    await first.play();
    this.timer = setInterval(() => {
      const a = this.els[this.active]?.el;
      if (!a || this.fading || !a.duration || a.paused) return;
      if (a.currentTime >= a.duration - crossfadeFor(a.duration) - 0.15) this.swap(false);
    }, 150) as unknown as ReturnType<typeof setTimeout>;
  }

  private swap(immediate: boolean) {
    if (this.fading && !immediate) return;
    const ctx = this.ctx!;
    const cur = this.els[this.active];
    const nxt = this.els[1 - this.active];
    if (!cur || !nxt) return;
    const X = immediate ? 0.05 : crossfadeFor(cur.el.duration);
    const t = ctx.currentTime;
    this.fading = true;
    nxt.el.currentTime = 0;
    void nxt.el.play().catch(() => {});
    nxt.g.gain.cancelScheduledValues(t);
    nxt.g.gain.setValueAtTime(0, t);
    nxt.g.gain.setValueCurveAtTime(UP, t, X);
    cur.g.gain.cancelScheduledValues(t);
    cur.g.gain.setValueAtTime(cur.g.gain.value, t);
    cur.g.gain.setValueCurveAtTime(DOWN, t, X);
    this.active = 1 - this.active;
    setTimeout(() => {
      cur.el.pause();
      this.fading = false;
    }, X * 1000 + 50);
  }

  // ---- controls ----
  async pause() {
    if (!this.ctx || this.state.status !== "playing") return;
    this.els.forEach((e) => e.el.pause());
    this.set({ status: "paused" });
    await this.ctx.suspend();
  }

  async resume() {
    if (!this.ctx || this.state.status !== "paused") return;
    await this.ctx.resume();
    await this.out?.play().catch(() => {});
    if (this.els.length) await this.els[this.active].el.play().catch(() => {});
    this.set({ status: this.ctx.state === "running" ? "playing" : "paused" });
  }

  toggle() {
    return this.state.status === "playing" ? this.pause() : this.resume();
  }

  stop() {
    this.token++;
    this.teardown();
    this.out?.pause();
    void this.ctx?.suspend();
    this.set({ status: "idle", itemId: null, error: undefined });
  }

  private teardown() {
    clearTimeout(this.timer);
    clearInterval(this.timer);
    this.voices.forEach((v) => {
      v.src.onended = null;
      try {
        v.src.stop();
      } catch {
        /* not started */
      }
      v.src.disconnect();
      v.g.disconnect();
    });
    this.voices.clear();
    this.buffer = undefined;
    this.els.forEach(({ el, node, g }) => {
      el.onended = null;
      el.pause();
      el.removeAttribute("src");
      el.load();
      node.disconnect();
      g.disconnect();
    });
    this.els = [];
    this.fading = false;
    if (this.elUrl) URL.revokeObjectURL(this.elUrl);
    this.elUrl = undefined;
  }

  /** For diagnostics/tests: number of live scheduled voices. */
  get voiceCount() {
    return this.voices.size;
  }
}

export const engine = typeof window === "undefined" ? (null as unknown as Engine) : new Engine();
