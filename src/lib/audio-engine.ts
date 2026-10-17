/**
 * Dreamer Audio Engine
 *
 * Implements hardware-driven native Web Audio buffer looping with a once-rendered
 * overlapping equal-power crossfade buffer. This eliminates interval timer starvation,
 * prevents background audio dropouts when tabs or screens sleep, guarantees continuous
 * looping without cutting out, and provides rock-solid Media Session controls.
 */

export type Status = "idle" | "loading" | "playing" | "paused" | "error";

export interface EngineMetadata {
  title?: string;
  coverBlob?: Blob;
}

export interface EngineState {
  status: Status;
  itemId: string | null;
  error?: string | undefined;
  position?: number;
  duration?: number;
}

export const CROSSFADE = 3;

/** Calculates proportional crossfade length up to CROSSFADE (3s), scaled down for short clips. */
export function crossfadeFor(duration: number): number {
  if (!Number.isFinite(duration) || duration <= 0) return 0;
  return Math.max(0, Math.min(CROSSFADE, duration * 0.4));
}

/** Determines if a file is safe to decode into an in-memory AudioBuffer. */
export function canDecode(size: number, duration: number, sampleRate: number): boolean {
  return (
    Number.isFinite(duration) &&
    duration > 0 &&
    size <= 16 * 1024 * 1024 &&
    size + duration * sampleRate * 8 * 4 * 2 <= 64 * 1024 * 1024
  );
}

// Pre-computed 128-point quarter-sine / quarter-cosine curves for equal-power crossfading
// Equal power property: UP[i]^2 + DOWN[i]^2 = sin^2(x) + cos^2(x) = 1.0 (constant acoustic power)
const UP = Float32Array.from({ length: 128 }, (_, i) => Math.sin(((i / 127) * Math.PI) / 2));
const DOWN = Float32Array.from({ length: 128 }, (_, i) => Math.cos(((i / 127) * Math.PI) / 2));

/**
 * Pre-renders an overlapping crossfade buffer once:
 * The tail (cycleDuration to duration) is crossfaded with equal-power curves into the head (0 to crossfade).
 * Native looping of this buffer is continuous and hardware-driven, avoiding periodic buffer scheduling
 * and eliminating background audio dropouts when tabs or mobile devices sleep.
 */
export function renderLoopBuffer(ctx: AudioContext, buffer: AudioBuffer): AudioBuffer {
  const duration = buffer.duration;
  const crossfade = crossfadeFor(duration);
  if (
    crossfade <= 0 ||
    duration <= crossfade ||
    typeof buffer.getChannelData !== "function" ||
    typeof ctx.createBuffer !== "function"
  ) {
    return buffer;
  }

  const sr = buffer.sampleRate || 48000;
  const numChannels = buffer.numberOfChannels || 1;
  const cycleDuration = duration - crossfade;
  const cycleFrames = Math.max(1, Math.round(cycleDuration * sr));
  const crossfadeFrames = Math.max(1, Math.round(crossfade * sr));

  try {
    const rendered = ctx.createBuffer(numChannels, cycleFrames, sr);
    for (let c = 0; c < numChannels; c++) {
      const src = buffer.getChannelData(c);
      const dst = rendered.getChannelData(c);
      for (let i = 0; i < crossfadeFrames; i++) {
        const theta = (Math.PI / 2) * (i / crossfadeFrames);
        const wTail = Math.cos(theta);
        const wHead = Math.sin(theta);
        const tailIdx = i + cycleFrames;
        const tailSample = tailIdx < src.length ? src[tailIdx]! : 0;
        const headSample = i < src.length ? src[i]! : 0;
        dst[i] = tailSample * wTail + headSample * wHead;
      }
      for (let i = crossfadeFrames; i < cycleFrames; i++) {
        dst[i] = i < src.length ? src[i]! : 0;
      }
    }
    return rendered;
  } catch {
    return buffer;
  }
}

/**
 * Native Web Audio hardware looper.
 * Plays the pre-rendered crossfade buffer using native C++ hardware clock looping (source.loop = true).
 * Runs completely independent of JavaScript timers and background throttling, preventing cutouts.
 */
class NativeBufferLooper {
  private source?: AudioBufferSourceNode;
  private loopBuffer: AudioBuffer;
  private startTime = 0;
  private startOffset = 0;

  constructor(
    private ctx: AudioContext,
    buffer: AudioBuffer,
    private destination: AudioNode,
    startOffset = 0,
  ) {
    this.loopBuffer = renderLoopBuffer(ctx, buffer);
    const dur = this.loopBuffer.duration || buffer.duration;
    this.startOffset = dur > 0 ? Math.max(0, startOffset % dur) : 0;
  }

  start() {
    this.stop();
    try {
      const source = this.ctx.createBufferSource();
      source.buffer = this.loopBuffer;
      source.loop = true;
      source.loopStart = 0;
      source.loopEnd = this.loopBuffer.duration;
      source.connect(this.destination);

      this.startTime = this.ctx.currentTime;
      source.start(0, this.startOffset);
      this.source = source;
    } catch (e) {
      console.warn("Failed to start native buffer looper:", e);
    }
  }

  getPosition(): number {
    const dur = this.loopBuffer.duration;
    if (!this.source || dur <= 0) return this.startOffset;
    const elapsed = this.ctx.currentTime - this.startTime + this.startOffset;
    return Math.max(0, elapsed % dur);
  }

  get voiceCount(): number {
    return this.source ? 1 : 0;
  }

  stop() {
    if (this.source) {
      try {
        this.source.stop();
        this.source.disconnect();
      } catch {
        /* ignore */
      }
      this.source = undefined;
    }
  }
}

type StreamVoice = { el: HTMLAudioElement; node: MediaElementAudioSourceNode; g: GainNode };

export class Engine {
  state: EngineState = { status: "idle", itemId: null };
  private listeners = new Set<(s: EngineState) => void>();
  private ctx?: AudioContext;
  private master?: GainNode;
  private fader?: GainNode;
  private out?: HTMLAudioElement;
  private token = 0;
  private looper?: NativeBufferLooper;
  private buffer?: AudioBuffer;
  private pausedPosition = 0;
  private timer?: ReturnType<typeof setInterval>;

  // Streamed fallback voices for very large audio files
  private els: StreamVoice[] = [];
  private elUrl?: string;
  private activeStreamVoice = 0;
  private streamTransition?: { outgoing: StreamVoice; end: number };
  private swapping = false;
  private cancelLoad?: () => void;

  // MediaSession metadata
  private metadata?: EngineMetadata;
  private mediaSessionCoverUrl?: string;

  constructor() {
    if (typeof document !== "undefined") {
      document.addEventListener("visibilitychange", () => {
        // Auto-resume audio context when returning to tab if it was suspended
        if (
          document.visibilityState === "visible" &&
          this.state.status === "playing" &&
          this.ctx?.state === "suspended"
        ) {
          void this.ctx.resume().catch(() => {});
        }
      });
    }
  }

  subscribe(fn: (s: EngineState) => void) {
    this.listeners.add(fn);
    fn(this.state);
    return () => void this.listeners.delete(fn);
  }

  private set(s: Partial<EngineState>) {
    const next = { ...this.state, ...s };
    if (next.status === "idle") {
      delete next.position;
    }
    this.state = next;
    this.listeners.forEach((l) => l(this.state));
    this.syncMediaSession();
  }

  private syncMediaSession() {
    if (typeof navigator === "undefined" || !navigator.mediaSession) return;
    const ms = navigator.mediaSession;
    ms.playbackState =
      this.state.status === "playing"
        ? "playing"
        : this.state.status === "paused"
          ? "paused"
          : "none";
  }

  setMetadata(meta: EngineMetadata) {
    this.metadata = meta;
    if (typeof navigator === "undefined" || !navigator.mediaSession) return;
    const ms = navigator.mediaSession;

    if (this.mediaSessionCoverUrl) {
      URL.revokeObjectURL(this.mediaSessionCoverUrl);
      this.mediaSessionCoverUrl = undefined;
    }

    if (meta.coverBlob) {
      this.mediaSessionCoverUrl = URL.createObjectURL(meta.coverBlob);
    }

    if (typeof MediaMetadata !== "undefined") {
      ms.metadata = new MediaMetadata({
        title: meta.title || "Dreamer",
        artwork: this.mediaSessionCoverUrl
          ? [{ src: this.mediaSessionCoverUrl, sizes: "512x512", type: "image/png" }]
          : [],
      });
    }

    ms.setActionHandler("play", () => void this.resume());
    ms.setActionHandler("pause", () => void this.pause());
    try {
      ms.setActionHandler("stop", () => void this.stop());
    } catch {
      /* stop action unsupported on some OSes */
    }

    try {
      // Ambient sound loops infinitely — suppress finite progress bar where supported
      if ("setPositionState" in ms) {
        ms.setPositionState?.(null as unknown as MediaPositionState);
      }
    } catch {
      /* ignore */
    }
  }

  private ensure() {
    if (this.ctx) return this.ctx;
    const ctx = new AudioContext();
    this.master = ctx.createGain();
    this.fader = ctx.createGain();
    this.fader.connect(this.master);
    this.master.connect(ctx.destination);

    // Audio carrier element / MediaStream destination for mobile background playback continuity
    if (typeof Audio !== "undefined") {
      try {
        if (
          typeof (
            ctx as unknown as {
              createMediaStreamDestination?: () => MediaStreamAudioDestinationNode;
            }
          ).createMediaStreamDestination === "function"
        ) {
          const dest = (
            ctx as unknown as {
              createMediaStreamDestination: () => MediaStreamAudioDestinationNode;
            }
          ).createMediaStreamDestination();
          this.master.connect(dest);
          this.out = new Audio();
          this.out.srcObject = dest.stream;
          this.out.volume = 1;
        } else {
          const SILENT_WAV =
            "data:audio/wav;base64,UklGRigAAABXQVZFZm10IBIAAAABAAEARKwAAIhYAQACABAAAABkYXRhAgAAAAEA";
          this.out = new Audio(SILENT_WAV);
          this.out.loop = true;
          this.out.volume = 0.01;
        }
      } catch {
        try {
          const SILENT_WAV =
            "data:audio/wav;base64,UklGRigAAABXQVZFZm10IBIAAAABAAEARKwAAIhYAQACABAAAABkYXRhAgAAAAEA";
          this.out = new Audio(SILENT_WAV);
          this.out.loop = true;
          this.out.volume = 0.01;
        } catch {
          /* ignore */
        }
      }
    }

    this.ctx = ctx;
    return ctx;
  }

  /** Starts playback of an audio item. Must be called from a user gesture. */
  async start(itemId: string, blob: Blob) {
    const token = ++this.token;
    this.set({ status: "loading", itemId, error: undefined });
    this.teardown();
    this.pausedPosition = 0;

    try {
      const ctx = this.ensure();
      void ctx.resume().catch(() => {});
      void this.out?.play().catch(() => {});

      this.elUrl = URL.createObjectURL(blob);
      const first = this.createVoice(this.elUrl, 1);
      await this.ready(first.el);
      if (token !== this.token) return;

      const duration = first.el.duration;
      if (!Number.isFinite(duration) || duration <= 0) {
        throw new Error("Invalid duration");
      }

      if (canDecode(blob.size, duration, ctx.sampleRate)) {
        const arrayBuf = await blob.arrayBuffer();
        if (token !== this.token) return;
        const decoded = await ctx.decodeAudioData(arrayBuf);
        if (token !== this.token) return;

        this.releaseElements();
        this.buffer = decoded;

        // Create native hardware buffer looper with once-rendered equal-power crossfade
        this.looper = new NativeBufferLooper(ctx, decoded, this.fader ?? ctx.destination, 0);
        this.looper.start();
      } else {
        // Streamed dual-voice fallback for long files
        const second = this.createVoice(this.elUrl, 0);
        await this.ready(second.el);
        if (token !== this.token) return;

        await first.el.play();
        if (token !== this.token) {
          first.el.pause();
          return;
        }
        this.timer = setInterval(() => this.tickStream(), 200);
      }

      await ctx.resume();
      if (token !== this.token) return;
      await this.out?.play().catch(() => {});
      if (token !== this.token) return;

      // Master fader smooth transition: fade in without clicks
      const fader = this.fader?.gain;
      if (fader) {
        fader.cancelScheduledValues(ctx.currentTime);
        fader.setValueAtTime(0, ctx.currentTime);
        fader.linearRampToValueAtTime(1, ctx.currentTime + 0.25);
      }

      this.set({
        status: ctx.state === "running" ? "playing" : "paused",
        duration: this.buffer ? this.buffer.duration : duration,
      });
    } catch {
      if (token !== this.token) return;
      this.set({ status: "error", error: "This audio can't be played." });
      this.teardown();
      this.out?.pause();
      void this.ctx?.suspend();
    }
  }

  private createVoice(url: string, value: number): StreamVoice {
    const ctx = this.ctx;
    if (!ctx) throw new Error("Context missing");
    const el = new Audio();
    el.preload = "auto";
    const node = ctx.createMediaElementSource(el);
    const g = ctx.createGain();
    g.gain.value = value;
    node.connect(g).connect(this.fader ?? this.master ?? ctx.destination);
    const voice = { el, node, g };
    this.els.push(voice);
    el.src = url;
    return voice;
  }

  private ready(el: HTMLAudioElement) {
    return new Promise<void>((resolve, reject) => {
      const cleanup = () => {
        el.removeEventListener("canplay", success);
        el.removeEventListener("error", failure);
        if (this.cancelLoad === cancel) this.cancelLoad = undefined;
      };
      const success = () => {
        cleanup();
        resolve();
      };
      const failure = () => {
        cleanup();
        reject(new Error("decode"));
      };
      const cancel = () => {
        cleanup();
        reject(new Error("cancelled"));
      };
      this.cancelLoad = cancel;
      el.addEventListener("canplay", success);
      el.addEventListener("error", failure);
      if (el.readyState >= 3) success();
      else if (el.error) failure();
      else el.load();
    });
  }

  private tickStream() {
    const ctx = this.ctx;
    if (!ctx || this.state.status !== "playing") return;
    if (this.streamTransition) {
      if (ctx.currentTime < this.streamTransition.end) return;
      this.streamTransition.outgoing.el.pause();
      this.streamTransition.outgoing.el.currentTime = 0;
      this.streamTransition = undefined;
    }
    const cur = this.els[this.activeStreamVoice];
    if (!cur || this.swapping) return;
    if (cur.el.ended || cur.el.currentTime >= cur.el.duration - crossfadeFor(cur.el.duration)) {
      void this.swapStream();
    }
  }

  private async swapStream() {
    const ctx = this.ctx;
    const cur = this.els[this.activeStreamVoice];
    const nxt = this.els[1 - this.activeStreamVoice];
    if (!ctx || !cur || !nxt || this.swapping) return;

    const token = this.token;
    this.swapping = true;
    try {
      nxt.el.currentTime = 0;
      await nxt.el.play();
      if (token !== this.token) {
        nxt.el.pause();
        return;
      }
      const t = ctx.currentTime;
      const x = Math.max(
        0.01,
        Math.min(crossfadeFor(cur.el.duration), cur.el.duration - cur.el.currentTime),
      );
      nxt.g.gain.cancelScheduledValues(t);
      nxt.g.gain.setValueAtTime(0, t);
      nxt.g.gain.setValueCurveAtTime(UP, t, x);

      cur.g.gain.cancelScheduledValues(t);
      cur.g.gain.setValueAtTime(1, t);
      cur.g.gain.setValueCurveAtTime(DOWN, t, x);

      this.activeStreamVoice = 1 - this.activeStreamVoice;
      this.streamTransition = { outgoing: cur, end: t + x };
      if (this.state.status !== "playing") nxt.el.pause();
    } catch {
      if (token === this.token) {
        this.set({ status: "error", error: "Playback interrupted. Tap play to retry." });
        this.teardown();
        this.out?.pause();
      }
    } finally {
      if (token === this.token) this.swapping = false;
    }
  }

  async pause() {
    const ctx = this.ctx;
    if (!ctx || this.state.status !== "playing") return;

    // Record position before stopping
    if (this.looper) {
      this.pausedPosition = this.looper.getPosition();
    } else if (this.els[this.activeStreamVoice]) {
      this.pausedPosition = this.els[this.activeStreamVoice]!.el.currentTime;
    }

    this.set({ status: "paused", position: this.pausedPosition });

    // Smooth fader micro fade-out to prevent audible pop
    const fader = this.fader?.gain;
    if (fader) {
      fader.cancelScheduledValues(ctx.currentTime);
      fader.setValueAtTime(fader.value, ctx.currentTime);
      fader.linearRampToValueAtTime(0, ctx.currentTime + 0.1);
    }

    await new Promise((r) => setTimeout(r, 100));

    if (this.looper) {
      this.looper.stop();
    }
    this.els.forEach(({ el }) => el.pause());
    this.out?.pause();
    await ctx.suspend().catch(() => {});
  }

  async resume() {
    const ctx = this.ctx;
    if (!ctx || this.state.status !== "paused") return;
    const token = this.token;

    try {
      await ctx.resume();
      if (token !== this.token) return;
      await this.out?.play().catch(() => {});
      if (token !== this.token) return;

      if (this.buffer) {
        // Restart native looper from exact paused offset
        this.looper = new NativeBufferLooper(
          ctx,
          this.buffer,
          this.fader ?? ctx.destination,
          this.pausedPosition,
        );
        this.looper.start();
      } else {
        const voices = this.streamTransition
          ? [this.els[this.activeStreamVoice], this.streamTransition.outgoing]
          : [this.els[this.activeStreamVoice]];
        await Promise.all(voices.map((v) => v?.el.play()));
        if (token !== this.token) {
          voices.forEach((v) => v?.el.pause());
          return;
        }
      }

      // Smooth master fader fade-in
      const fader = this.fader?.gain;
      if (fader) {
        fader.cancelScheduledValues(ctx.currentTime);
        fader.setValueAtTime(0, ctx.currentTime);
        fader.linearRampToValueAtTime(1, ctx.currentTime + 0.2);
      }

      this.set({ status: ctx.state === "running" ? "playing" : "paused" });
    } catch {
      if (token === this.token) {
        this.set({ status: "playing" });
        await this.pause();
      }
    }
  }

  toggle() {
    return this.state.status === "playing" ? this.pause() : this.resume();
  }

  stop() {
    ++this.token;
    // Reset position to 0 so next play starts from the beginning
    this.pausedPosition = 0;
    this.set({ status: "idle", itemId: null, error: undefined });
    this.teardown();
    this.out?.pause();
    void this.ctx?.suspend().catch(() => {});

    if (this.mediaSessionCoverUrl) {
      URL.revokeObjectURL(this.mediaSessionCoverUrl);
      this.mediaSessionCoverUrl = undefined;
    }
    if (typeof navigator !== "undefined" && navigator.mediaSession) {
      navigator.mediaSession.metadata = null;
      navigator.mediaSession.playbackState = "none";
    }
  }

  private releaseElements() {
    this.els.forEach(({ el, node, g }) => {
      el.pause();
      el.removeAttribute("src");
      el.load();
      try {
        node.disconnect();
        g.disconnect();
      } catch {
        /* ignore */
      }
    });
    this.els = [];
    if (this.elUrl) URL.revokeObjectURL(this.elUrl);
    this.elUrl = undefined;
  }

  private teardown() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
    this.cancelLoad?.();
    if (this.looper) {
      this.looper.stop();
      this.looper = undefined;
    }
    this.buffer = undefined;
    this.releaseElements();
    this.streamTransition = undefined;
    this.swapping = false;
    this.activeStreamVoice = 0;
  }

  get voiceCount(): number {
    if (this.looper) return this.looper.voiceCount;
    return this.els.filter(({ el }) => !el.paused).length;
  }

  get position(): number {
    if (this.state.status === "paused") return this.pausedPosition;
    if (this.looper) return this.looper.getPosition();
    if (this.els[this.activeStreamVoice]) return this.els[this.activeStreamVoice]!.el.currentTime;
    return 0;
  }

  get duration(): number {
    if (this.buffer) return this.buffer.duration;
    if (this.els[this.activeStreamVoice]) return this.els[this.activeStreamVoice]!.el.duration;
    return 0;
  }
}

export const engine = new Engine();
