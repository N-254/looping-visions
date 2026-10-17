/**
 * Dreamer YouTube Controller
 *
 * Implements direct host mounting, responsive iframe embedding, seamless looping,
 * and reliable Play / Pause / Stop controls for the official YouTube IFrame player.
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

export class YouTubeEngine {
  state: YouTubeState = { status: "idle", videoId: null, title: null };
  private listeners = new Set<(s: YouTubeState) => void>();
  private player: YTPlayer | null = null;
  private currentContainer: HTMLElement | null = null;
  private mountToken = 0;

  subscribe(fn: (s: YouTubeState) => void) {
    this.listeners.add(fn);
    fn(this.state);
    return () => void this.listeners.delete(fn);
  }

  private set(s: Partial<YouTubeState>) {
    this.state = { ...this.state, ...s };
    this.listeners.forEach((l) => l(this.state));
  }

  /**
   * Mounts and initializes the YouTube player directly in the target container.
   */
  async mount(container: HTMLElement, videoId: string, title?: string) {
    const token = ++this.mountToken;

    // Stop local audio engine when YouTube plays
    engine.stop();

    // If same video is already mounted in this container and player exists, just resume
    if (
      this.player &&
      this.state.videoId === videoId &&
      this.currentContainer === container &&
      typeof this.player.playVideo === "function"
    ) {
      this.set({ status: "playing", title: title ?? this.state.title });
      try {
        this.player.playVideo();
      } catch {
        /* ignore */
      }
      return;
    }

    // Clean up any existing player
    this.cleanupPlayer();
    this.currentContainer = container;

    this.set({
      status: "loading",
      videoId,
      title: title ?? null,
      error: undefined,
    });

    try {
      const YT = await loadYouTubeApi();
      if (token !== this.mountToken || !container.isConnected) return;

      container.innerHTML = "";
      const targetDiv = document.createElement("div");
      targetDiv.style.width = "100%";
      targetDiv.style.height = "100%";
      container.appendChild(targetDiv);

      this.player = new YT.Player(targetDiv, {
        videoId,
        width: "100%",
        height: "100%",
        playerVars: {
          autoplay: 1,
          playsinline: 1,
          rel: 0,
          enablejsapi: 1,
          loop: 1,
          playlist: videoId, // In YouTube iframe API, loop requires playlist set to videoId
          origin: typeof window !== "undefined" ? window.location.origin : undefined,
        },
        events: {
          onReady: (e: { target: YTPlayer }) => {
            if (token !== this.mountToken) return;
            try {
              if (typeof e.target.playVideo === "function") {
                e.target.playVideo();
              }
            } catch {
              /* ignore */
            }
            this.set({ status: "playing" });
          },
          onStateChange: (e: { data: number; target: YTPlayer }) => {
            if (token !== this.mountToken) return;
            const S = YT.PlayerState;
            if (e.data === S.ENDED) {
              // Seamless loop: seek back to 0 and play
              try {
                if (typeof e.target.seekTo === "function") e.target.seekTo(0, true);
                if (typeof e.target.playVideo === "function") e.target.playVideo();
              } catch {
                /* ignore */
              }
            } else if (e.data === S.PLAYING) {
              this.set({ status: "playing" });
            } else if (e.data === S.PAUSED) {
              this.set({ status: "paused" });
            } else if (e.data === S.BUFFERING) {
              this.set({ status: "loading" });
            }
          },
          onError: () => {
            if (token !== this.mountToken) return;
            this.set({ status: "error", error: "Video unavailable or cannot be embedded." });
          },
        },
      });
    } catch (err) {
      if (token !== this.mountToken) return;
      this.set({ status: "error", error: (err as Error).message });
    }
  }

  // Compatibility helper
  load(videoId: string, title?: string, _coverBlob?: Blob) {
    this.set({ videoId, title: title ?? null });
  }

  play() {
    if (this.player && typeof this.player.playVideo === "function") {
      try {
        this.player.playVideo();
      } catch {
        /* ignore */
      }
    }
    this.set({ status: "playing" });
  }

  pause() {
    if (this.player && typeof this.player.pauseVideo === "function") {
      try {
        this.player.pauseVideo();
      } catch {
        /* ignore */
      }
    }
    this.set({ status: "paused" });
  }

  stop() {
    if (this.player) {
      try {
        if (typeof this.player.seekTo === "function") this.player.seekTo(0, true);
        if (typeof this.player.pauseVideo === "function") this.player.pauseVideo();
      } catch {
        /* ignore */
      }
    }
    this.set({ status: "idle" });
  }

  destroy() {
    ++this.mountToken;
    this.cleanupPlayer();
    this.set({ status: "idle", videoId: null, title: null, error: undefined });
  }

  toggle() {
    if (this.state.status === "playing") {
      this.pause();
    } else {
      this.play();
    }
  }

  private cleanupPlayer() {
    if (this.player && typeof this.player.destroy === "function") {
      try {
        this.player.destroy();
      } catch {
        /* ignore */
      }
      this.player = null;
    }
    if (this.currentContainer) {
      this.currentContainer.innerHTML = "";
      this.currentContainer = null;
    }
  }
}

export const youtubeEngine = new YouTubeEngine();
