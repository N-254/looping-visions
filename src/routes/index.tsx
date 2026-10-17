import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import {
  Check,
  GripVertical,
  Pause,
  Pencil,
  Play,
  Plus,
  Square,
  Trash2,
  Volume2,
  X,
  Youtube,
} from "lucide-react";
import {
  getAll,
  putItem,
  removeItem,
  requestPersistence,
  saveOrder,
  storageErrorMessage,
  type Item,
} from "@/lib/db";
import { ItemForm } from "@/components/ItemForm";
import { Player } from "@/components/Player";
import { engine, type EngineState } from "@/lib/audio-engine";
import { youtubeEngine, type YouTubeState } from "@/lib/youtube-engine";

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "Dreamer" },
      { name: "description", content: "A personal gallery of images paired with looping sound." },
      { property: "og:title", content: "Dreamer" },
      {
        property: "og:description",
        content: "A personal gallery of images paired with looping sound.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
  }),
  component: Gallery,
});

type Mode = "view" | "edit" | "reorder";

function useThumbs(items: Item[]) {
  const cache = useRef(new Map<Blob, string>());
  const map = new Map<string, string>();
  for (const it of items) {
    let u = cache.current.get(it.thumb);
    if (!u) {
      u = URL.createObjectURL(it.thumb);
      cache.current.set(it.thumb, u);
    }
    map.set(it.id, u);
  }
  useEffect(() => {
    const live = new Set(items.map((i) => i.thumb));
    for (const [b, u] of cache.current)
      if (!live.has(b)) {
        URL.revokeObjectURL(u);
        cache.current.delete(b);
      }
  }, [items]);
  return map;
}

function Gallery() {
  const [items, setItems] = useState<Item[] | null>(null);
  const [mode, setMode] = useState<Mode>("view");
  const [form, setForm] = useState<{ item?: Item } | null>(null);
  const [open, setOpen] = useState<Item | null>(null);
  const [confirmId, setConfirmId] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [dragId, setDragId] = useState<string | null>(null);
  const [engineState, setEngineState] = useState<EngineState>(
    () => engine?.state ?? { status: "idle", itemId: null },
  );
  const [ytState, setYtState] = useState<YouTubeState>(() => youtubeEngine.state);
  const thumbs = useThumbs(items ?? []);

  useEffect(() => {
    getAll()
      .then(setItems)
      .catch(() => {
        setItems([]);
        setError("Storage unavailable in this browser.");
      });
  }, []);

  // Keep gallery in sync with local audio engine and YouTube background engine
  useEffect(() => {
    if (!engine) return;
    return engine.subscribe(setEngineState);
  }, []);

  useEffect(() => {
    return youtubeEngine.subscribe(setYtState);
  }, []);

  const openItem = (it: Item) => {
    if (it.source?.type === "file") {
      if (
        engine.state.itemId !== it.id ||
        engine.state.status === "idle" ||
        engine.state.status === "error"
      ) {
        youtubeEngine.destroy();
        engine.setMetadata({ title: it.title, coverBlob: it.cover });
        void engine.start(it.id, it.source.blob);
      }
    } else if (it.source?.type === "youtube") {
      engine.stop();
    }
    setOpen(it);
  };

  const save = async (d: Omit<Item, "id" | "order">) => {
    const list = items ?? [];
    const prev = form?.item;
    const item: Item = prev
      ? { ...prev, ...d }
      : {
          ...d,
          id: crypto.randomUUID(),
          order: list.length ? Math.max(...list.map((i) => i.order)) + 1 : 0,
        };
    try {
      await putItem(item);
    } catch (e) {
      throw new Error(storageErrorMessage(e));
    }
    requestPersistence();
    setItems(prev ? list.map((i) => (i.id === item.id ? item : i)) : [...list, item]);
    setForm(null);
  };

  const del = async (id: string) => {
    if (engine.state.itemId === id) {
      engine.stop();
    }
    const itemToDelete = items?.find((i) => i.id === id);
    if (
      itemToDelete?.source?.type === "youtube" &&
      ytState.videoId === itemToDelete.source.videoId
    ) {
      youtubeEngine.destroy();
    }
    try {
      await removeItem(id);
      setItems((l) => l!.filter((i) => i.id !== id));
    } catch (e) {
      setError(storageErrorMessage(e));
    }
    setConfirmId(null);
  };

  const persistOrder = async (list: Item[]) => {
    try {
      await saveOrder(list);
      setItems(list.map((it, i) => ({ ...it, order: i })));
    } catch (e) {
      setError(storageErrorMessage(e));
    }
  };

  const move = (from: number, to: number, persist: boolean) => {
    if (!items || to < 0 || to >= items.length || from === to) return;
    const l = [...items];
    const [x] = l.splice(from, 1);
    l.splice(to, 0, x!);
    setItems(l);
    if (persist) void persistOrder(l);
  };

  const onPointerMove = (e: React.PointerEvent) => {
    if (!dragId || !items) return;
    const el = document.elementFromPoint(e.clientX, e.clientY)?.closest<HTMLElement>("[data-idx]");
    if (!el) return;
    const to = Number(el.dataset["idx"]);
    const from = items.findIndex((i) => i.id === dragId);
    move(from, to, false);
  };
  const endDrag = () => {
    if (dragId && items) void persistOrder(items);
    setDragId(null);
  };

  const toggleMode = (m: Mode) => {
    setConfirmId(null);
    setMode((cur) => (cur === m ? "view" : m));
  };

  // Find if local audio is currently active in the background
  const activePlayingItem =
    !open &&
    items?.find((i) => {
      if (!i) return false;
      return (
        i.id === engineState.itemId &&
        (engineState.status === "playing" || engineState.status === "paused")
      );
    });

  const activeStatus = engineState.status;

  return (
    <main className="min-h-dvh pb-20">
      <header className="safe-top sticky top-0 z-10 flex justify-end gap-1 bg-background/85 px-2 pb-2 backdrop-blur">
        {!!items?.length && (
          <>
            <button
              className="icon-btn"
              aria-label="Reorder"
              aria-pressed={mode === "reorder"}
              onClick={() => toggleMode("reorder")}
            >
              <GripVertical className="size-5" />
            </button>
            <button
              className="icon-btn"
              aria-label="Edit"
              aria-pressed={mode === "edit"}
              onClick={() => toggleMode("edit")}
            >
              <Pencil className="size-5" />
            </button>
          </>
        )}
        <button className="icon-btn" aria-label="Add" onClick={() => setForm({})}>
          <Plus className="size-6" />
        </button>
      </header>

      {error && (
        <button
          role="alert"
          onClick={() => setError("")}
          className="mx-3 mb-2 block w-[calc(100%-1.5rem)] rounded-lg bg-muted px-3 py-2 text-left text-sm text-destructive"
        >
          {error}
        </button>
      )}

      {items && items.length === 0 && (
        <div className="flex min-h-[70dvh] items-center justify-center">
          <button
            onClick={() => setForm({})}
            aria-label="Add"
            className="flex size-28 items-center justify-center rounded-2xl border border-dashed border-input text-muted-foreground"
          >
            <Plus className="size-10" />
          </button>
        </div>
      )}

      <ul
        className="safe-bottom grid grid-cols-2 gap-x-2 gap-y-3 px-2 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5"
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        style={{ touchAction: mode === "reorder" ? "none" : undefined }}
      >
        {items?.map((it, idx) => {
          const isLocalActive =
            engineState.itemId === it.id &&
            (engineState.status === "playing" || engineState.status === "paused");
          const isYtActive =
            it.source?.type === "youtube" &&
            ytState.videoId === it.source.videoId &&
            (ytState.status === "playing" || ytState.status === "paused");
          const isItemActive = isLocalActive || isYtActive;
          const currentItemStatus = isYtActive ? ytState.status : engineState.status;

          return (
            <li
              key={it.id}
              data-idx={idx}
              className={`select-none transition-opacity ${dragId === it.id ? "opacity-50" : ""}`}
            >
              <div className="relative aspect-square overflow-hidden rounded-xl bg-muted">
                <button
                  className="block size-full"
                  aria-label={
                    mode === "reorder" ? `Move ${it.title}, use arrow keys` : `Open ${it.title}`
                  }
                  onClick={() => mode === "view" && openItem(it)}
                  onPointerDown={(e) => {
                    if (mode !== "reorder") return;
                    e.currentTarget.releasePointerCapture?.(e.pointerId);
                    setDragId(it.id);
                  }}
                  onKeyDown={(e) => {
                    if (mode !== "reorder") return;
                    if (e.key === "ArrowLeft" || e.key === "ArrowUp") move(idx, idx - 1, true);
                    if (e.key === "ArrowRight" || e.key === "ArrowDown") move(idx, idx + 1, true);
                  }}
                >
                  <img
                    src={thumbs.get(it.id)}
                    alt=""
                    loading="lazy"
                    decoding="async"
                    draggable={false}
                    className="size-full object-cover"
                  />
                </button>

                {/* Active playback indicator on card */}
                {isItemActive && (
                  <div
                    className="glass-btn pointer-events-none absolute left-2 top-2 flex items-center gap-1.5 px-2.5 py-1 text-xs font-semibold text-primary shadow-md backdrop-blur-md"
                    aria-label={currentItemStatus === "playing" ? "Playing" : "Paused"}
                  >
                    {currentItemStatus === "playing" ? (
                      <span className="flex items-center gap-0.5">
                        <span className="inline-block h-3 w-0.5 animate-pulse rounded-full bg-primary" />
                        <span className="inline-block h-4 w-0.5 animate-pulse rounded-full bg-primary [animation-delay:150ms]" />
                        <span className="inline-block h-2 w-0.5 animate-pulse rounded-full bg-primary [animation-delay:300ms]" />
                      </span>
                    ) : (
                      <Pause className="size-3 text-primary" />
                    )}
                    <span className="text-[10px] uppercase tracking-wider">
                      {currentItemStatus === "playing" ? "Active" : "Paused"}
                    </span>
                  </div>
                )}

                {it.source?.type === "youtube" && !isItemActive && (
                  <Youtube
                    className="pointer-events-none absolute left-2 top-2 size-4 text-on-scrim opacity-80"
                    aria-hidden
                  />
                )}
                {mode === "reorder" && (
                  <GripVertical
                    className="glass-btn pointer-events-none absolute right-2 top-2 size-8 p-1.5"
                    aria-hidden
                  />
                )}
                {mode === "edit" && (
                  <div className="absolute right-2 top-2 flex gap-1.5">
                    {confirmId === it.id ? (
                      <>
                        <button
                          className="glass-btn size-9"
                          aria-label="Cancel delete"
                          onClick={() => setConfirmId(null)}
                        >
                          <X className="size-4" />
                        </button>
                        <button
                          className="glass-btn size-9 text-destructive"
                          aria-label={`Confirm delete ${it.title}`}
                          onClick={() => void del(it.id)}
                        >
                          <Check className="size-4" />
                        </button>
                      </>
                    ) : (
                      <>
                        <button
                          className="glass-btn size-9"
                          aria-label={`Edit ${it.title}`}
                          onClick={() => setForm({ item: it })}
                        >
                          <Pencil className="size-4" />
                        </button>
                        <button
                          className="glass-btn size-9"
                          aria-label={`Delete ${it.title}`}
                          onClick={() => setConfirmId(it.id)}
                        >
                          <Trash2 className="size-4" />
                        </button>
                      </>
                    )}
                  </div>
                )}
              </div>
              <p className="mt-1.5 truncate px-0.5 text-xs text-muted-foreground">{it.title}</p>
            </li>
          );
        })}
      </ul>

      {/* Floating mini-control pill when audio continues playing in the gallery */}
      {activePlayingItem && (
        <aside
          aria-label="Now playing"
          className="safe-bottom fixed inset-x-0 bottom-3 z-20 flex justify-center px-3"
        >
          <div className="glass-btn flex items-center gap-3 rounded-full border border-border/40 bg-scrim/80 py-1.5 pl-2 pr-3 shadow-2xl backdrop-blur-xl">
            <button
              onClick={() => setOpen(activePlayingItem)}
              className="flex items-center gap-2.5 text-left outline-none"
              aria-label={`Open player for ${activePlayingItem.title}`}
            >
              <img
                src={thumbs.get(activePlayingItem.id)}
                alt=""
                className="size-9 rounded-full object-cover ring-1 ring-white/20"
              />
              <div className="max-w-[130px] sm:max-w-[200px]">
                <p className="truncate text-xs font-medium text-on-scrim">
                  {activePlayingItem.title}
                </p>
                <p className="flex items-center gap-1 text-[10px] text-muted-foreground">
                  <Volume2 className="size-2.5 text-primary" />
                  {activeStatus === "playing" ? "Playing" : "Paused"}
                </p>
              </div>
            </button>

            <div className="flex items-center gap-1 border-l border-white/10 pl-2">
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  engine?.stop();
                }}
                className="glass-btn size-8 rounded-full p-1 text-on-scrim hover:bg-white/20"
                aria-label="Stop sound and reset to beginning"
                title="Stop and reset to beginning"
              >
                <Square className="size-3.5 fill-current" />
              </button>
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  void engine?.toggle();
                }}
                className="glass-btn size-8 rounded-full p-1 text-on-scrim hover:bg-white/20"
                aria-label={activeStatus === "playing" ? "Pause" : "Play"}
                title={activeStatus === "playing" ? "Pause" : "Play"}
              >
                {activeStatus === "playing" ? (
                  <Pause className="size-4" />
                ) : (
                  <Play className="size-4" />
                )}
              </button>
            </div>
          </div>
        </aside>
      )}

      {open && <Player key={open.id} item={open} onClose={() => setOpen(null)} />}
      {form && <ItemForm initial={form.item} onCancel={() => setForm(null)} onSave={save} />}
    </main>
  );
}
