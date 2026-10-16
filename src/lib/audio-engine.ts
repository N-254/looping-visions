/** One local playback session: bounded native-loop buffers or two streamed voices. */
export type Status = "idle" | "loading" | "playing" | "paused" | "error";
export interface EngineState {
  status: Status;
  itemId: string | null;
  error?: string | undefined;
}
export const CROSSFADE = 3;
export function crossfadeFor(duration: number) {
  return Math.max(0, Math.min(CROSSFADE, duration * 0.4));
}
// Account for encoded data plus two PCM buffers, conservatively up to 8 channels.
export function canDecode(size: number, duration: number, sampleRate: number) {
  return Number.isFinite(duration) && duration > 0 && size <= 16 * 1024 * 1024 &&
    size + duration * sampleRate * 8 * 4 * 2 <= 64 * 1024 * 1024;
}
function curve(up: boolean) {
  return Float32Array.from({ length: 128 }, (_, i) =>
    up ? Math.sin(i / 127 * Math.PI / 2) : Math.cos(i / 127 * Math.PI / 2));
}
const UP = curve(true);
const DOWN = curve(false);
type Voice = { el: HTMLAudioElement; node: MediaElementAudioSourceNode; g: GainNode };

export class Engine {
  state: EngineState = { status: "idle", itemId: null };
  private listeners = new Set<(s: EngineState) => void>();
  private ctx?: AudioContext;
  private master?: GainNode;
  private out?: HTMLAudioElement;
  private token = 0;
  private source?: AudioBufferSourceNode;
  private timer?: ReturnType<typeof setInterval>;
  private els: Voice[] = [];
  private elUrl?: string;
  private active = 0;
  private transition?: { outgoing: Voice; end: number };
  private swapping = false;
  private cancelLoad?: () => void;

  subscribe(fn: (s: EngineState) => void) {
    this.listeners.add(fn);
    fn(this.state);
    return () => void this.listeners.delete(fn);
  }
  private set(s: Partial<EngineState>) {
    this.state = { ...this.state, ...s };
    this.listeners.forEach((l) => l(this.state));
    if (navigator.mediaSession) navigator.mediaSession.playbackState =
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
      this.out.addEventListener("pause", () => {
        if (this.state.status === "playing") void this.pause();
      });
    } else this.master.connect(ctx.destination);
    this.ctx = ctx;
    return ctx;
  }
  /** Called from a user gesture; no playback starts in a React effect. */
  async start(itemId: string, blob: Blob) {
    const token = ++this.token;
    this.set({ status: "loading", itemId, error: undefined });
    this.teardown();
    try {
      const ctx = this.ensure();
      // Unlock the output before awaiting metadata/decode.
      void ctx.resume().catch(() => {});
      void this.out?.play().catch(() => {});
      this.elUrl = URL.createObjectURL(blob);
      const first = this.createVoice(this.elUrl, 1);
      await this.ready(first.el);
      if (token !== this.token) return;
      if (canDecode(blob.size, first.el.duration, ctx.sampleRate)) {
        const buffer = await ctx.decodeAudioData(await blob.arrayBuffer());
        if (token !== this.token) return;
        const loop = await this.renderLoop(buffer);
        if (token !== this.token) return;
        this.releaseElements();
        const source = ctx.createBufferSource();
        source.buffer = loop;
        source.loop = true;
        source.connect(this.master ?? ctx.destination);
        this.source = source;
        source.start();
      } else {
        const second = this.createVoice(this.elUrl, 0);
        await this.ready(second.el);
        if (token !== this.token) return;
        if (!Number.isFinite(first.el.duration) || first.el.duration <= 0) throw new Error("duration");
        await first.el.play();
        if (token !== this.token) { first.el.pause(); return; }
        this.timer = setInterval(() => this.tick(), 50);
      }
      await ctx.resume();
      if (token !== this.token) return;
      await this.out?.play();
      if (token !== this.token) return;
      const gain = this.master?.gain;
      gain?.cancelScheduledValues(ctx.currentTime);
      gain?.setValueAtTime(0, ctx.currentTime);
      gain?.linearRampToValueAtTime(1, ctx.currentTime + 0.4);
      this.set({ status: ctx.state === "running" ? "playing" : "paused" });
    } catch {
      if (token !== this.token) return;
      this.set({ status: "error", error: "This audio can't be played." });
      this.teardown();
      this.out?.pause();
      void this.ctx?.suspend();
    }
  }
  /** Render actual overlapping end/start voices once, then native-loop without JS timers. */
  private async renderLoop(buffer: AudioBuffer) {
    if (buffer.duration < 0.5) return buffer;
    const overlap = crossfadeFor(buffer.duration);
    const duration = buffer.duration - overlap;
    const offline = new OfflineAudioContext(buffer.numberOfChannels,
      Math.round(duration * buffer.sampleRate), buffer.sampleRate);
    const outgoing = offline.createBufferSource();
    outgoing.buffer = buffer;
    const down = offline.createGain();
    outgoing.connect(down).connect(offline.destination);
    down.gain.setValueAtTime(1, 0);
    down.gain.setValueCurveAtTime(DOWN, duration - overlap, overlap);
    outgoing.start(0, overlap, duration);
    const incoming = offline.createBufferSource();
    incoming.buffer = buffer;
    const up = offline.createGain();
    incoming.connect(up).connect(offline.destination);
    up.gain.setValueAtTime(0, 0);
    up.gain.setValueCurveAtTime(UP, duration - overlap, overlap);
    incoming.start(duration - overlap, 0, overlap);
    return offline.startRendering();
  }
  private createVoice(url: string, value: number) {
    const ctx = this.ctx;
    if (!ctx) throw new Error("context");
    const el = new Audio();
    el.preload = "auto";
    const node = ctx.createMediaElementSource(el);
    const g = ctx.createGain();
    g.gain.value = value;
    node.connect(g).connect(this.master ?? ctx.destination);
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
      const success = () => { cleanup(); resolve(); };
      const failure = () => { cleanup(); reject(new Error("decode")); };
      const cancel = () => { cleanup(); reject(new Error("cancelled")); };
      this.cancelLoad = cancel;
      el.addEventListener("canplay", success);
      el.addEventListener("error", failure);
      if (el.readyState >= 3) success();
      else if (el.error) failure();
      else el.load();
    });
  }
  private tick() {
    const ctx = this.ctx;
    if (!ctx || this.state.status !== "playing") return;
    if (this.transition) {
      if (ctx.currentTime < this.transition.end) return;
      this.transition.outgoing.el.pause();
      this.transition.outgoing.el.currentTime = 0;
      this.transition = undefined;
    }
    const cur = this.els[this.active];
    if (!cur || this.swapping) return;
    if (cur.el.ended || cur.el.currentTime >= cur.el.duration - crossfadeFor(cur.el.duration))
      void this.swap();
  }
  private async swap() {
    const ctx = this.ctx;
    const cur = this.els[this.active];
    const nxt = this.els[1 - this.active];
    if (!ctx || !cur || !nxt || this.swapping) return;
    const token = this.token;
    this.swapping = true;
    try {
      nxt.el.currentTime = 0;
      await nxt.el.play();
      if (token !== this.token) { nxt.el.pause(); return; }
      const t = ctx.currentTime;
      // Never run a fade longer than the actual outgoing audio still available.
      const x = Math.max(0.01, Math.min(crossfadeFor(cur.el.duration), cur.el.duration - cur.el.currentTime));
      nxt.g.gain.cancelScheduledValues(t);
      nxt.g.gain.setValueAtTime(0, t);
      nxt.g.gain.setValueCurveAtTime(UP, t, x);
      cur.g.gain.cancelScheduledValues(t);
      cur.g.gain.setValueAtTime(1, t);
      cur.g.gain.setValueCurveAtTime(DOWN, t, x);
      this.active = 1 - this.active;
      this.transition = { outgoing: cur, end: t + x };
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
    this.set({ status: "paused" });
    this.els.forEach(({ el }) => el.pause());
    this.out?.pause();
    await ctx.suspend();
  }
  async resume() {
    const ctx = this.ctx;
    if (!ctx || this.state.status !== "paused") return;
    const token = this.token;
    try {
      await ctx.resume();
      if (token !== this.token) return;
      await this.out?.play();
      if (token !== this.token) return;
      const voices = this.transition ? [this.els[this.active], this.transition.outgoing] : [this.els[this.active]];
      await Promise.all(voices.map((v) => v?.el.play()));
      if (token !== this.token) { voices.forEach((v) => v?.el.pause()); return; }
      this.set({ status: ctx.state === "running" ? "playing" : "paused" });
    } catch {
      if (token === this.token) { this.set({ status: "playing" }); await this.pause(); }
    }
  }
  toggle() { return this.state.status === "playing" ? this.pause() : this.resume(); }
  stop() {
    ++this.token;
    this.set({ status: "idle", itemId: null, error: undefined });
    this.teardown();
    this.out?.pause();
    void this.ctx?.suspend();
  }
  private releaseElements() {
    this.els.forEach(({ el, node, g }) => {
      el.pause();
      el.removeAttribute("src");
      el.load();
      node.disconnect();
      g.disconnect();
    });
    this.els = [];
    if (this.elUrl) URL.revokeObjectURL(this.elUrl);
    this.elUrl = undefined;
  }
  private teardown() {
    clearInterval(this.timer);
    this.timer = undefined;
    this.cancelLoad?.();
    if (this.source) {
      this.source.stop();
      this.source.disconnect();
      this.source.buffer = null;
      this.source = undefined;
    }
    this.releaseElements();
    this.transition = undefined;
    this.swapping = false;
    this.active = 0;
  }
  get voiceCount() { return this.source ? 1 : this.els.filter(({ el }) => !el.paused).length; }
}
export const engine = typeof window === "undefined" ? (null as unknown as Engine) : new Engine();
