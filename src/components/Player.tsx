import { useEffect, useRef, useState } from "react";
import { ChevronDown, Loader2, Pause, Play, Square } from "lucide-react";
import { Button } from "@/components/ui/button";
import { isDismissSwipe, type SwipePoint } from "@/lib/player-gesture";
import type { Item } from "@/lib/db";
import { engine, type EngineState } from "@/lib/audio-engine";
import { youtubeEngine, type YouTubeState } from "@/lib/youtube-engine";

type UI = { status: EngineState["status"] | YouTubeState["status"]; error?: string | undefined };

export function Player({ item, onClose }: { item: Item; onClose: () => void }) {
  const [cover, setCover] = useState("");
  const [showControls, setShowControls] = useState(true);
  const isYt = item.source?.type === "youtube";

  const [ui, setUi] = useState<UI>(() => {
    if (isYt && item.source?.type === "youtube") {
      return {
        status:
          youtubeEngine.state.videoId === item.source.videoId
            ? youtubeEngine.state.status
            : "loading",
        error: youtubeEngine.state.error,
      };
    }
    return {
      status:
        item.source?.type === "file" && engine?.state?.itemId === item.id
          ? engine.state.status
          : "loading",
      error:
        item.source?.type === "file" && engine?.state?.itemId === item.id
          ? engine.state.error
          : undefined,
    };
  });

  const ytHost = useRef<HTMLDivElement>(null);
  const dialog = useRef<HTMLDivElement>(null);
  const gesture = useRef<(SwipePoint & { id: number }) | null>(null);

  useEffect(() => {
    const previous = document.activeElement;
    dialog.current?.focus();
    const overflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = overflow;
      if (previous instanceof HTMLElement) previous.focus();
    };
  }, []);

  useEffect(() => {
    if (!item.cover || item.cover.size === 0) return;
    const u = URL.createObjectURL(item.cover);
    setCover(u);
    return () => URL.revokeObjectURL(u);
  }, [item.cover]);

  // Synchronize MediaSession metadata for local audio
  useEffect(() => {
    if (!isYt) {
      engine?.setMetadata?.({
        title: item.title,
        coverBlob: item.cover,
      });
    }
  }, [item, isYt]);

  // Local audio: mirror engine state
  useEffect(() => {
    if (isYt || !engine) return;
    return engine.subscribe((s) => {
      if (s.itemId === item.id || s.status === "idle") {
        setUi({ status: s.status, error: s.error });
      }
    });
  }, [isYt, item.id]);

  // YouTube player mount and lifecycle
  useEffect(() => {
    if (item.source?.type !== "youtube") return;
    const { videoId } = item.source;

    let active = true;
    if (ytHost.current) {
      void youtubeEngine.mount(ytHost.current, videoId, item.title);
    }

    const unsub = youtubeEngine.subscribe((s) => {
      if (active) {
        setUi({ status: s.status, error: s.error });
      }
    });

    return () => {
      active = false;
      unsub();
      youtubeEngine.destroy();
    };
  }, [item]);

  const play = () => {
    if (isYt) {
      youtubeEngine.play();
    } else {
      if ((ui.status === "idle" || ui.status === "error") && item.source?.type === "file") {
        void engine.start(item.id, item.source.blob);
      } else {
        void engine?.resume();
      }
    }
  };

  const pause = () => {
    if (isYt) {
      youtubeEngine.pause();
    } else {
      void engine?.pause();
    }
  };

  // Stop button: stops playback and takes the sound back to the beginning
  const stop = () => {
    if (isYt) {
      youtubeEngine.stop();
      setUi({ status: "idle" });
    } else {
      engine?.stop();
      setUi({ status: "idle" });
    }
  };

  const close = () => {
    gesture.current = null;
    onClose();
  };

  const toggle = () => {
    if (isYt) {
      if (ui.status === "error" || ui.status === "idle") {
        youtubeEngine.play();
        return;
      }
      return ui.status === "playing" ? pause() : play();
    }

    if ((ui.status === "error" || ui.status === "idle") && item.source?.type === "file") {
      return void engine.start(item.id, item.source.blob);
    }
    return ui.status === "playing" ? pause() : play();
  };

  useEffect(() => {
    const k = (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
      if (e.key === " ") {
        if (
          e.target instanceof Element &&
          e.target.closest("button, input, select, textarea, iframe")
        )
          return;
        e.preventDefault();
        toggle();
      }
      if (e.key === "Tab" && dialog.current) {
        const controls = [
          ...dialog.current.querySelectorAll<HTMLElement>("button:not(:disabled), iframe"),
        ];
        const first = controls[0];
        const last = controls[controls.length - 1];
        if (
          e.shiftKey &&
          (document.activeElement === first || document.activeElement === dialog.current)
        ) {
          e.preventDefault();
          last?.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first?.focus();
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
      className="fixed inset-0 z-30 touch-pinch-zoom bg-background outline-none select-none"
      role="dialog"
      aria-modal="true"
      aria-label={item.title}
      onPointerDown={(e) => {
        if (
          !e.isPrimary ||
          e.button !== 0 ||
          (e.target instanceof Element && e.target.closest("button, iframe, [data-player-control]"))
        )
          return;
        gesture.current = { id: e.pointerId, x: e.clientX, y: e.clientY, time: e.timeStamp };
        e.currentTarget.setPointerCapture?.(e.pointerId);
      }}
      onPointerUp={(e) => {
        const start = gesture.current;
        gesture.current = null;
        if (!start || start.id !== e.pointerId) return;

        const dx = e.clientX - start.x;
        const dy = e.clientY - start.y;
        const elapsed = e.timeStamp - start.time;

        // Swipe down to dismiss back to gallery
        if (isDismissSwipe(start, { x: e.clientX, y: e.clientY, time: e.timeStamp })) {
          close();
          return;
        }

        // Tap on empty area: toggle controls
        if (Math.abs(dx) < 14 && Math.abs(dy) < 14 && elapsed < 400) {
          setShowControls((prev) => !prev);
        }
      }}
      onPointerCancel={() => {
        gesture.current = null;
      }}
      onLostPointerCapture={() => {
        gesture.current = null;
      }}
    >
      {/* Immersive background artwork */}
      {cover && <img src={cover} alt="" className="absolute inset-0 size-full object-cover" />}

      {/* Subtle black gradient overlays for depth and readability */}
      <div
        className={`pointer-events-none absolute inset-x-0 top-0 h-36 bg-gradient-to-b from-black/80 via-black/40 to-transparent transition-opacity duration-300 ${
          showControls ? "opacity-100" : "opacity-0"
        }`}
      />
      <div
        className={`pointer-events-none absolute inset-x-0 bottom-0 h-56 bg-gradient-to-t from-black/85 via-black/40 to-transparent transition-opacity duration-300 ${
          showControls ? "opacity-100" : "opacity-0"
        }`}
      />

      {/* Top bar: Dismiss button and title */}
      <div
        className={`safe-top absolute inset-x-0 top-0 flex items-center justify-between px-3 pt-3 transition-opacity duration-300 ${
          showControls ? "pointer-events-auto opacity-100" : "pointer-events-none opacity-0"
        }`}
        data-player-control
      >
        <button
          onClick={close}
          className="glass-btn flex size-10 items-center justify-center rounded-full text-on-scrim shadow-md backdrop-blur-md hover:bg-white/20 active:scale-95"
          aria-label="Close player and return to gallery"
          title="Return to gallery"
        >
          <ChevronDown className="size-5" />
        </button>

        <h1 className="glass-btn max-w-[70vw] truncate px-3 py-1.5 text-xs font-medium tracking-wide text-on-scrim shadow-lg backdrop-blur-md sm:max-w-[80vw] sm:text-sm">
          {item.title}
        </h1>

        <div className="size-10" aria-hidden="true" />
      </div>

      {/* Bottom controls: Stop button (resets to beginning) & Play/Pause */}
      <div
        className={`safe-bottom absolute inset-x-0 bottom-0 flex flex-col items-center gap-4 px-4 pb-8 transition-opacity duration-300 ${
          showControls ? "pointer-events-auto opacity-100" : "pointer-events-none opacity-0"
        }`}
        data-player-control
      >
        {ui.error && (
          <p
            role="alert"
            className="glass-btn px-4 py-2 text-xs font-medium text-destructive backdrop-blur-md"
          >
            {ui.error}
          </p>
        )}

        {isYt && (
          <div
            ref={ytHost}
            data-player-control
            className="aspect-video w-72 max-w-[85vw] touch-auto overflow-hidden rounded-xl bg-black/60 shadow-2xl sm:w-80"
          />
        )}

        <div className="flex items-center justify-center gap-5" data-player-control>
          {/* Square-style Stop button: stops and resets playback to the beginning */}
          <Button
            variant="ghost"
            size="icon"
            className="glass-btn size-12 rounded-2xl text-on-scrim shadow-md transition-all hover:bg-white/20 active:scale-95"
            onClick={(e) => {
              e.stopPropagation();
              stop();
            }}
            aria-label="Stop sound and reset to beginning"
            title="Stop and reset to beginning"
            disabled={ui.status === "idle" || ui.status === "loading"}
          >
            <Square className="size-5 fill-current" />
          </Button>

          {/* Play/Pause control */}
          <Button
            variant="ghost"
            size="icon"
            className="glass-btn size-14 rounded-full text-on-scrim shadow-lg transition-all hover:bg-white/20 active:scale-95"
            onClick={(e) => {
              e.stopPropagation();
              toggle();
            }}
            aria-label={ui.status === "playing" ? "Pause" : "Play"}
            title={ui.status === "playing" ? "Pause" : "Play"}
            disabled={ui.status === "loading"}
          >
            <Icon className={`size-6 ${ui.status === "loading" ? "animate-spin" : ""}`} />
          </Button>
        </div>
      </div>
    </div>
  );
}
