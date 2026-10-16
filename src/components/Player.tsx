import { useEffect, useRef, useState } from "react";
import { X, Loader2, Pause, Play } from "lucide-react";
import { Button } from "@/components/ui/button";
import { isDismissSwipe, type SwipePoint } from "@/lib/player-gesture";
import type { Item } from "@/lib/db";
import { engine, type EngineState } from "@/lib/audio-engine";
import { loadYouTubeApi, type YTPlayer } from "@/lib/youtube";

type UI = { status: EngineState["status"]; error?: string | undefined };

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
  const dialog = useRef<HTMLDivElement>(null);
  const gesture = useRef<(SwipePoint & { id: number }) | null>(null);
  const isYt = item.source.type === "youtube";

  useEffect(() => {
    const previous = document.activeElement;
    dialog.current?.focus();
    const overflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = overflow;
      if (!isYt) engine.stop();
      if (previous instanceof HTMLElement) previous.focus();
    };
  }, [isYt]);

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
            onError: () => { if (!dead) setUi({ status: "error", error: "Video unavailable or can't be embedded." }); },
          },
        });
        setUi({ status: "paused" });
      })
      .catch((e: Error) => { if (!dead) setUi({ status: "error", error: e.message }); });
    return () => {
      dead = true;
      yt.current?.destroy();
      yt.current = null;
    };
  }, [item.source]);

  const play = () => (isYt ? yt.current?.playVideo() : void engine.resume());
  const pause = () => (isYt ? yt.current?.pauseVideo() : void engine.pause());
  const close = () => {
    gesture.current = null;
    if (isYt) yt.current?.pauseVideo();
    else engine.stop();
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
        if (e.target instanceof Element && e.target.closest("button, input, select, textarea, iframe")) return;
        e.preventDefault();
        toggle();
      }
      if (e.key === "Tab" && dialog.current) {
        const controls = [...dialog.current.querySelectorAll<HTMLElement>("button:not(:disabled), iframe")];
        const first = controls[0];
        const last = controls[controls.length - 1];
        if (e.shiftKey && (document.activeElement === first || document.activeElement === dialog.current)) {
          e.preventDefault(); last?.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault(); first?.focus();
        }
      }
    };
    window.addEventListener("keydown", k);
    return () => window.removeEventListener("keydown", k);
  });

  const Icon = ui.status === "loading" ? Loader2 : ui.status === "playing" ? Pause : Play;

  return (
    <div
      ref={dialog}
      tabIndex={-1}
      className="fixed inset-0 z-30 touch-pinch-zoom bg-background outline-none"
      role="dialog" aria-modal="true" aria-label={item.title}
      onPointerDown={(e) => {
        if (!e.isPrimary || e.button !== 0 || (e.target instanceof Element && e.target.closest("button, iframe, [data-player-control]"))) return;
        gesture.current = { id: e.pointerId, x: e.clientX, y: e.clientY, time: e.timeStamp };
        e.currentTarget.setPointerCapture?.(e.pointerId);
      }}
      onPointerUp={(e) => {
        const start = gesture.current;
        gesture.current = null;
        if (start?.id === e.pointerId && isDismissSwipe(start, { x: e.clientX, y: e.clientY, time: e.timeStamp })) close();
      }}
      onPointerCancel={() => { gesture.current = null; }}
      onLostPointerCapture={() => { gesture.current = null; }}
    >
      {cover && <img src={cover} alt="" className="absolute inset-0 size-full object-cover" />}
      <div className="safe-top absolute inset-x-0 top-0 flex items-center gap-2 px-3">
        <Button variant="ghost" size="icon" className="glass-btn size-11 [&_svg]:size-6" onClick={close} aria-label="Close player" title="Close player">
          <X />
        </Button>
        <h1 className="glass-btn truncate px-3 py-1.5 text-sm font-medium">{item.title}</h1>
      </div>

      <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
        <Button
          variant="ghost" size="icon"
          className="glass-btn pointer-events-auto size-20 [&_svg]:size-9"
          onClick={toggle}
          aria-label={ui.status === "playing" ? "Pause" : "Play"}
          disabled={ui.status === "loading" && !isYt}
        >
          <Icon className={`size-9 ${ui.status === "loading" ? "animate-spin" : ""}`} />
        </Button>
      </div>

      <div className="safe-bottom absolute inset-x-0 bottom-0 flex flex-col items-center gap-2 px-4">
        {ui.error && (
          <p role="alert" className="glass-btn px-3 py-1.5 text-sm">
            {ui.error}
          </p>
        )}
        {isYt && (
          <div ref={ytHost} data-player-control className="aspect-video w-56 touch-auto overflow-hidden rounded-lg bg-scrim" />
        )}
      </div>
    </div>
  );
}
