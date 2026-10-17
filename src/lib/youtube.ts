const ID = /^[\w-]{11}$/;

export function parseYouTube(input: string): string | null {
  let u: URL;
  try {
    u = new URL(input.trim());
  } catch {
    return null;
  }
  if (!/^https?:$/.test(u.protocol)) return null;
  const host = u.hostname.replace(/^(www|m|music)\./, "");
  let id: string | null = null;
  if (host === "youtu.be") id = u.pathname.split("/")[1] ?? null;
  else if (host === "youtube.com" || host === "youtube-nocookie.com") {
    if (u.pathname === "/watch") id = u.searchParams.get("v");
    else {
      const m = u.pathname.match(/^\/(shorts|embed|live|v)\/([^/]+)/);
      id = m?.[2] ?? null;
    }
  }
  return id && ID.test(id) ? id : null;
}

/* Minimal typing for the official IFrame API. */
export interface YTPlayer {
  playVideo(): void;
  pauseVideo(): void;
  seekTo(s: number, allow: boolean): void;
  destroy(): void;
}
declare global {
  interface Window {
    YT?: {
      Player: new (el: HTMLElement, opts: unknown) => YTPlayer;
      PlayerState: {
        ENDED: number;
        PLAYING: number;
        PAUSED: number;
        CUED: number;
        BUFFERING: number;
      };
    };
    onYouTubeIframeAPIReady?: () => void;
  }
}

let apiP: Promise<NonNullable<Window["YT"]>> | null = null;
export function loadYouTubeApi() {
  if (!apiP) {
    apiP = new Promise((res, rej) => {
      if (window.YT?.Player) return res(window.YT);
      const prev = window.onYouTubeIframeAPIReady;
      window.onYouTubeIframeAPIReady = () => {
        prev?.();
        res(window.YT!);
      };
      const s = document.createElement("script");
      s.src = "https://www.youtube.com/iframe_api";
      s.onerror = () => {
        apiP = null;
        rej(new Error("YouTube unavailable. Check connection."));
      };
      document.head.appendChild(s);
    });
  }
  return apiP;
}
