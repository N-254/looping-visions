import { useEffect, useRef, useState } from "react";
import { ChevronLeft, Loader2, Pause, Play } from "lucide-react";
import type { Item } from "@/lib/db";
import { engine, type EngineState } from "@/lib/audio-engine";
import { loadYouTubeApi, type YTPlayer } from "@/lib/youtube";

type UI = { status: EngineState["status"]; error?: string };

function setSession(item: Item, cover: string, play: () => void, pause: () => void, stop: () => void) {
  const ms = navigator.mediaSession;
  if (!ms || typeof MediaMetadata === "undefined") return () => {};
  ms.metadata = new MediaMetadata({ title: item.title, artwork: [{ src: cover, sizes: "512x512" }] });
  ms.setActionHandler("play", play);
  ms.setActionHandler("pause", pause);
  try {
    ms.setActionHandler("stop", stop);
  } catch {
    /* unsupported */
  }
  return () => {
    ms.metadata = null;
    (["play", "pause", "stop"] as const).forEach((a) => {
      try {
        ms.setActionHandler(a, null);
      } catch {
        /* unsupported */
      }
    });
    ms.playbackState = "none";
  };
}

export function Player({ item, onClose }: { item: Item; onClose: () => void }) {
  const [cover, setCover] = useState("");
  const [ui, setUi] = useState<UI>({ status: "loading" });
  const ytHost = useRef<HTMLDivElement>(null);
  const yt = useRef<YTPlayer | null>(null);
  const isYt = item.source.type === "youtube";

  useEffect(() => {
    const u = URL.createObjectURL(item.cover);
    setCover(u);
    return () => URL.revokeObjectURL(u);
  }, [item.cover]);

  // Local audio: mirror the real engine state.
  useEffect(() => {
    if (isYt) return;
    return engine.subscribe((s) => {
      if (s.itemId === item.id || s.status === "idle") setUi({ status: s.status, error: s.error });
    });
  }, [isYt, item.id]);

  // YouTube: official IFrame player, visible.
  useEffect(() => {
    if (item.source.type !== "youtube") return;
    const { videoId } = item.source;
    let dead = false;
    loadYouTubeApi()
      .then((YT) => {
        if (dead || !ytHost.current) return;
        const el = document.createElement("div");
        ytHost.current.appendChild(el);
        yt.current = new YT.Player(el, {
          videoId,
          width: "100%",
          height: "100%",
          playerVars: { autoplay: 1, playsinline: 1, rel: 0 },
          events: {
            onReady: (e: { target: YTPlayer }) => e.target.playVideo(),
            onStateChange: (e: { data: number; target: YTPlayer }) => {
              const S = YT.PlayerState;
              if (e.data === S.ENDED) {
                e.target.seekTo(0, true);
                e.target.playVideo();
              } else if (e.data === S.PLAYING) setUi({ status: "playing" });
              else if (e.data === S.PAUSED || e.data === S.CUED) setUi({ status: "paused" });
              else if (e.data === S.BUFFERING) setUi({ status: "loading" });
            },
            onError: () => setUi({ status: "error", error: "Video unavailable or can't be embedded." }),
          },
        });
        setUi({ status: "paused" });
      })
      .catch((e: Error) => setUi({ status: "error", error: e.message }));
    return () => {
      dead = true;
      yt.current?.destroy();
      yt.current = null;
    };
  }, [item.source]);

  const play = () => (isYt ? yt.current?.playVideo() : void engine.resume());
  const pause = () => (isYt ? yt.current?.pauseVideo() : void engine.pause());
  const close = () => {
    if (!isYt) engine.stop();
    onClose();
  };
  const toggle = () => {
    if (!isYt && (ui.status === "error" || ui.status === "idle") && item.source.type === "file")
      return void engine.start(item.id, item.source.blob);
    return ui.status === "playing" ? pause() : play();
  };

  useEffect(() => {
    if (!cover) return;
    return setSession(item, cover, play, pause, close);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cover, item]);

  useEffect(() => {
    const k = (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
      if (e.key === " ") {
        e.preventDefault();
        toggle();
      }
    };
    window.addEventListener("keydown", k);
    return () => window.removeEventListener("keydown", k);
  });

  const Icon = ui.status === "loading" ? Loader2 : ui.status === "playing" ? Pause : Play;

  return (
    <div className="fixed inset-0 z-30 bg-background" role="dialog" aria-modal="true" aria-label={item.title}>
      {cover && <img src={cover} alt="" className="absolute inset-0 size-full object-cover" />}
      <div className="safe-top absolute inset-x-0 top-0 flex items-center gap-2 px-3">
        <button className="glass-btn size-11" onClick={close} aria-label="Back">
          <ChevronLeft className="size-6" />
        </button>
        <h1 className="glass-btn truncate px-3 py-1.5 text-sm font-medium">{item.title}</h1>
      </div>

      <div className="absolute inset-0 flex items-center justify-center">
        <button
          className="glass-btn size-20"
          onClick={toggle}
          aria-label={ui.status === "playing" ? "Pause" : "Play"}
          disabled={ui.status === "loading" && !isYt}
        >
          <Icon className={`size-9 ${ui.status === "loading" ? "animate-spin" : ""}`} />
        </button>
      </div>

      <div className="safe-bottom absolute inset-x-0 bottom-0 flex flex-col items-center gap-2 px-4">
        {ui.error && (
          <p role="alert" className="glass-btn px-3 py-1.5 text-sm">
            {ui.error}
          </p>
        )}
        {isYt && (
          <div ref={ytHost} className="aspect-video w-56 overflow-hidden rounded-lg bg-scrim" />
        )}
      </div>
    </div>
  );
}
