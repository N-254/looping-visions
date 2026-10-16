import { useEffect, useRef, useState } from "react";
import { Check, FileAudio, ImagePlus, Loader2, X, Youtube } from "lucide-react";
import type { Item, Source } from "@/lib/db";
import { checkAudio, processImage } from "@/lib/media";
import { parseYouTube } from "@/lib/youtube";

interface Props {
  initial?: Item;
  onCancel: () => void;
  onSave: (data: { title: string; cover: Blob; thumb: Blob; source: Source }) => Promise<void>;
}

export function ItemForm({ initial, onCancel, onSave }: Props) {
  const [title, setTitle] = useState(initial?.title ?? "");
  const [img, setImg] = useState<{ cover: Blob; thumb: Blob } | null>(
    initial ? { cover: initial.cover, thumb: initial.thumb } : null,
  );
  const [kind, setKind] = useState<"file" | "youtube">(initial?.source.type ?? "file");
  const [audio, setAudio] = useState<{ blob: Blob; name: string } | null>(
    initial?.source.type === "file" ? { blob: initial.source.blob, name: initial.source.name } : null,
  );
  const [url, setUrl] = useState(initial?.source.type === "youtube" ? initial.source.url : "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [preview, setPreview] = useState<string>("");
  const imgInput = useRef<HTMLInputElement>(null);
  const audioInput = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!img) return setPreview("");
    const u = URL.createObjectURL(img.thumb);
    setPreview(u);
    return () => URL.revokeObjectURL(u);
  }, [img]);

  const pickImage = async (f?: File) => {
    if (!f) return;
    setError("");
    setBusy(true);
    try {
      setImg(await processImage(f));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const pickAudio = async (f?: File) => {
    if (!f) return;
    setError("");
    setBusy(true);
    try {
      await checkAudio(f);
      setAudio({ blob: f, name: f.name });
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (busy) return;
    if (!img) return setError("Add a cover image.");
    if (!title.trim()) return setError("Add a title.");
    let source: Source;
    if (kind === "file") {
      if (!audio) return setError("Add an audio file.");
      source = { type: "file", blob: audio.blob, name: audio.name };
    } else {
      const id = parseYouTube(url);
      if (!id) return setError("Invalid YouTube link.");
      source = { type: "youtube", videoId: id, url: url.trim() };
    }
    setBusy(true);
    setError("");
    try {
      await onSave({ title: title.trim(), cover: img.cover, thumb: img.thumb, source });
    } catch (err) {
      setError((err as Error).message || "Could not save.");
      setBusy(false);
    }
  };

  const seg = (k: "file" | "youtube", Icon: typeof FileAudio, label: string) => (
    <button
      type="button"
      role="radio"
      aria-checked={kind === k}
      onClick={() => {
        setKind(k);
        setError("");
      }}
      className="flex flex-1 items-center justify-center gap-2 rounded-lg py-2.5 text-sm text-muted-foreground transition-colors aria-checked:bg-primary aria-checked:text-primary-foreground"
    >
      <Icon className="size-4" aria-hidden />
      {label}
    </button>
  );

  return (
    <div
      className="fixed inset-0 z-40 flex items-end justify-center bg-scrim backdrop-blur-sm sm:items-center"
      role="dialog"
      aria-modal="true"
      aria-label={initial ? "Edit item" : "New item"}
      onKeyDown={(e) => e.key === "Escape" && onCancel()}
    >
      <form
        onSubmit={submit}
        className="safe-bottom w-full max-w-md space-y-4 rounded-t-2xl bg-card p-4 sm:rounded-2xl"
      >
        <div className="flex items-center justify-between">
          <button type="button" className="icon-btn" onClick={onCancel} aria-label="Cancel">
            <X className="size-5" />
          </button>
          <button
            type="submit"
            disabled={busy}
            className="icon-btn bg-primary text-primary-foreground hover:bg-primary disabled:opacity-50"
            aria-label="Save"
          >
            {busy ? <Loader2 className="size-5 animate-spin" /> : <Check className="size-5" />}
          </button>
        </div>

        <button
          type="button"
          onClick={() => imgInput.current?.click()}
          className="relative flex aspect-[4/3] w-full items-center justify-center overflow-hidden rounded-xl bg-muted text-muted-foreground"
          aria-label={img ? "Change cover image" : "Choose cover image"}
        >
          {preview ? (
            <img src={preview} alt="" className="absolute inset-0 size-full object-cover" />
          ) : (
            <ImagePlus className="size-8" aria-hidden />
          )}
        </button>
        <input
          ref={imgInput}
          type="file"
          accept="image/*"
          hidden
          onChange={(e) => {
            void pickImage(e.target.files?.[0]);
            e.target.value = "";
          }}
        />

        <input
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="Title"
          aria-label="Title"
          maxLength={80}
          className="w-full rounded-lg border border-input bg-transparent px-3 py-2.5 text-base outline-none focus:border-ring"
        />

        <div role="radiogroup" aria-label="Audio source" className="flex gap-1 rounded-xl bg-muted p-1">
          {seg("file", FileAudio, "File")}
          {seg("youtube", Youtube, "YouTube")}
        </div>

        {kind === "file" ? (
          <>
            <button
              type="button"
              onClick={() => audioInput.current?.click()}
              className="flex w-full items-center gap-3 rounded-lg border border-input px-3 py-2.5 text-left text-sm"
            >
              <FileAudio className="size-4 shrink-0 text-muted-foreground" aria-hidden />
              <span className={`truncate ${audio ? "" : "text-muted-foreground"}`}>
                {audio?.name ?? "Choose audio"}
              </span>
            </button>
            <input
              ref={audioInput}
              type="file"
              accept="audio/*"
              hidden
              onChange={(e) => {
                void pickAudio(e.target.files?.[0]);
                e.target.value = "";
              }}
            />
          </>
        ) : (
          <div className="space-y-1.5">
            <input
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder="https://youtu.be/…"
              aria-label="YouTube link"
              inputMode="url"
              className="w-full rounded-lg border border-input bg-transparent px-3 py-2.5 text-base outline-none focus:border-ring"
            />
            <p className="text-xs text-muted-foreground">
              Official YouTube player. No crossfade; may pause in background.
            </p>
          </div>
        )}

        {error && (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        )}
      </form>
    </div>
  );
}
