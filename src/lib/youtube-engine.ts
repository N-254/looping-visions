/**
 * YouTube Background Audio & Screen-Off Playback Controller
 *
 * Implements persistent DOM hosting, background audio carrier, visibility-change
 * auto-resume, lock-screen Media Session integration, and rewind-to-beginning stop for official YouTube IFrame player.
 */

import { loadYouTubeApi, type YTPlayer } from "./youtube";
import { engine } from "./audio-engine";

export type YouTubeStatus = "idle" | "loading" | "playing" | "paused" | "error";

export interface YouTubeState {
  status: YouTubeStatus;
  videoId: string | null;
  title: string | null;
  error?: string | undefined;
}

const SILENT_WAV =
  "data:audio/wav;base64,UklGRigAAABXQVZFZm10IBIAAAABAAEARKwAAIhYAQACABAAAABkYXRhAgAAAAEA";

export class YouTubeEngine {
  state: YouTubeState = { status: "idle", videoId: null, title: null };
  private listeners = new Set<(s: YouTubeState) => void>();
  private player: YTPlayer | null = null;
  private container: HTMLDivElement | null = null;
  private persistentHost: HTMLDivElement | null = null;
  private isUserPaused = true;
  private isStopped = true;
  private carrier: HTMLAudioElement | null = null;
  private coverUrl?: string;

  constructor() {
    if (typeof window !== "undefined") {
      this.initCarrier();
      this.initPersistentHost();
      this.initVisibilityListener();
    }
  }

  subscribe(fn: (s: YouTubeState) => void) {
    this.listeners.add(fn);
    fn(this.state);
    return () => void this.listeners.delete(fn);
  }

  private set(s: Partial<YouTubeState>) {
    this.state = { ...this.state, ...s };
    this.listeners.forEach((l) => l(this.state));
    this.syncMediaSession();
  }

  private initCarrier() {
    try {
      this.carrier = new Audio(SILENT_WAV);
      this.carrier.loop = true;
      this.carrier.volume = 0.01;
    } catch {
      /* ignore */
    }
  }

  private initPersistentHost() {
    if (typeof document === "undefined") return;
    const el = document.createElement("div");
    el.id = "dreamer-youtube-persistent";
    el.style.position = "fixed";
    el.style.bottom = "-9999px";
    el.style.left = "-9999px";
    el.style.width = "1px";
    el.style.height = "1px";
    el.style.overflow = "hidden";
    el.style.pointerEvents = "none";
    el.style.opacity = "0.01";
    document.body.appendChild(el);
    this.persistentHost = el;
  }

  private initVisibilityListener() {
    if (typeof document === "undefined") return;
    const resumeIfHidden = () => {
      // When screen turns off or tab is hidden while playing
      if (document.visibilityState === "hidden" && !this.isUserPaused && this.player) {
        void this.carrier?.play().catch(() => {});
        // Counteract YouTube iframe auto-pause on screen off / tab hide
        setTimeout(() => {
          if (!this.isUserPaused && typeof this.player?.playVideo === "function") {
            try {
              this.player.playVideo();
            } catch {
              /* ignore */
            }
          }
        }, 100);
        setTimeout(() => {
          if (!this.isUserPaused && typeof this.player?.playVideo === "function") {
            try {
              this.player.playVideo();
            } catch {
              /* ignore */
            }
          }
        }, 500);
        setTimeout(() => {
          if (!this.isUserPaused && typeof this.player?.playVideo === "function") {
            try {
              this.player.playVideo();
            } catch {
              /* ignore */
            }
          }
        }, 1200);
      }
    };

    document.addEventListener("visibilitychange", resumeIfHidden);
    if (typeof window !== "undefined") {
      window.addEventListener("pagehide", resumeIfHidden);
    }
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

  setMetadata(title: string, coverBlob?: Blob) {
    if (typeof navigator === "undefined" || !navigator.mediaSession) return;
    const ms = navigator.mediaSession;

    if (this.coverUrl) {
      URL.revokeObjectURL(this.coverUrl);
      this.coverUrl = undefined;
    }
    if (coverBlob) {
      this.coverUrl = URL.createObjectURL(coverBlob);
    }

    if (typeof MediaMetadata !== "undefined") {
      ms.metadata = new MediaMetadata({
        title,
        artwork: this.coverUrl ? [{ src: this.coverUrl, sizes: "512x512", type: "image/png" }] : [],
      });
    }

    ms.setActionHandler("play", () => void this.play());
    ms.setActionHandler("pause", () => void this.pause());
    try {
      ms.setActionHandler("stop", () => void this.stop());
    } catch {
      /* ignore */
    }
  }

  async load(videoId: string, title: string, coverBlob?: Blob) {
    // Stop local audio engine when YouTube starts
    engine.stop();

    if (this.state.videoId === videoId && this.player) {
      this.set({ title });
      this.setMetadata(title, coverBlob);
      this.play();
      return;
    }

    this.set({ status: "loading", videoId, title, error: undefined });
    this.isUserPaused = false;
    this.isStopped = false;
    this.setMetadata(title, coverBlob);

    try {
      const YT = await loadYouTubeApi();

      if (!this.container) {
        this.container = document.createElement("div");
        this.container.style.width = "100%";
        this.container.style.height = "100%";
        if (this.persistentHost) {
          this.persistentHost.appendChild(this.container);
        }
      }

      if (this.player && typeof this.player.destroy === "function") {
        try {
          this.player.destroy();
        } catch {
          /* ignore */
        }
        this.player = null;
      }

      const playerTarget = document.createElement("div");
      this.container.innerHTML = "";
      this.container.appendChild(playerTarget);

      this.player = new YT.Player(playerTarget, {
        videoId,
        width: "100%",
        height: "100%",
        playerVars: {
          autoplay: 1,
          playsinline: 1,
          rel: 0,
          enablejsapi: 1,
          origin: typeof window !== "undefined" ? window.location.origin : undefined,
        },
        events: {
          onReady: (e: { target: YTPlayer }) => {
            try {
              if (typeof e.target.playVideo === "function") {
                e.target.playVideo();
                void this.carrier?.play().catch(() => {});
              }
            } catch {
              /* ignore */
            }
            this.set({ status: "playing" });
          },
          onStateChange: (e: { data: number; target: YTPlayer }) => {
            const S = YT.PlayerState;
            if (e.data === S.ENDED) {
              // Seamless loop
              if (typeof e.target.seekTo === "function") e.target.seekTo(0, true);
              if (typeof e.target.playVideo === "function") e.target.playVideo();
            } else if (e.data === S.PLAYING) {
              this.isUserPaused = false;
              this.isStopped = false;
              void this.carrier?.play().catch(() => {});
              this.set({ status: "playing" });
            } else if (e.data === S.PAUSED) {
              if (this.isStopped) {
                this.set({ status: "idle" });
                return;
              }
              // If document is hidden and user didn't request pause, auto-resume for background playback
              if (
                typeof document !== "undefined" &&
                document.visibilityState === "hidden" &&
                !this.isUserPaused
              ) {
                setTimeout(() => {
                  if (typeof e.target.playVideo === "function" && !this.isUserPaused) {
                    try {
                      e.target.playVideo();
                    } catch {
                      /* ignore */
                    }
                  }
                }, 100);
              } else {
                this.set({ status: "paused" });
              }
            } else if (e.data === S.BUFFERING) {
              this.set({ status: "loading" });
            }
          },
          onError: () => {
            this.set({ status: "error", error: "Video unavailable or can't be embedded." });
          },
        },
      });
    } catch (e) {
      this.set({ status: "error", error: (e as Error).message });
    }
  }

  attachTo(host: HTMLElement) {
    if (this.container && host !== this.container.parentElement) {
      host.appendChild(this.container);
    }
  }

  detachToPersistent() {
    if (
      this.container &&
      this.persistentHost &&
      this.container.parentElement !== this.persistentHost
    ) {
      this.persistentHost.appendChild(this.container);
    }
  }

  play() {
    this.isUserPaused = false;
    if (this.isStopped) {
      this.isStopped = false;
      if (typeof this.player?.seekTo === "function") {
        try {
          this.player.seekTo(0, true);
        } catch {
          /* ignore */
        }
      }
    }
    void this.carrier?.play().catch(() => {});
    if (typeof this.player?.playVideo === "function") {
      try {
        this.player.playVideo();
      } catch {
        /* ignore */
      }
    }
    this.set({ status: "playing" });
  }

  pause() {
    this.isUserPaused = true;
    this.carrier?.pause();
    if (typeof this.player?.pauseVideo === "function") {
      try {
        this.player.pauseVideo();
      } catch {
        /* ignore */
      }
    }
    this.set({ status: "paused" });
  }

  stop() {
    this.isUserPaused = true;
    this.isStopped = true;
    this.carrier?.pause();
    if (typeof this.player?.seekTo === "function") {
      try {
        this.player.seekTo(0, true);
      } catch {
        /* ignore */
      }
    }
    if (typeof this.player?.pauseVideo === "function") {
      try {
        this.player.pauseVideo();
      } catch {
        /* ignore */
      }
    }
    this.set({ status: "idle" });
  }

  toggle() {
    if (this.state.status === "playing") {
      this.pause();
    } else {
      this.play();
    }
  }
}

export const youtubeEngine = new YouTubeEngine();
