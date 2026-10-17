export type Source =
  { type: "file"; blob: Blob; name: string } | { type: "youtube"; videoId: string; url: string };

export interface Item {
  id: string;
  title: string;
  order: number;
  cover: Blob;
  thumb: Blob;
  source: Source;
}

const DB_NAME = "dreamer";
const STORE = "items";
let dbp: Promise<IDBDatabase> | null = null;

function open(): Promise<IDBDatabase> {
  if (!dbp) {
    dbp = new Promise((res, rej) => {
      const r = indexedDB.open(DB_NAME, 1);
      r.onupgradeneeded = () => r.result.createObjectStore(STORE, { keyPath: "id" });
      r.onsuccess = () => res(r.result);
      r.onerror = () => {
        dbp = null;
        rej(r.error);
      };
    });
  }
  return dbp;
}

async function run(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => void): Promise<void> {
  const db = await open();
  return new Promise((res, rej) => {
    const t = db.transaction(STORE, mode);
    fn(t.objectStore(STORE));
    t.oncomplete = () => res();
    t.onerror = () => rej(t.error);
    t.onabort = () => rej(t.error ?? new Error("aborted"));
  });
}

export async function getAll(): Promise<Item[]> {
  const db = await open();
  return new Promise((res, rej) => {
    const r = db.transaction(STORE).objectStore(STORE).getAll();
    r.onsuccess = () => {
      const raw = (r.result as Record<string, unknown>[]) || [];
      const items: Item[] = raw
        .filter((it): it is Record<string, unknown> => it != null && typeof it === "object")
        .map((it) => {
          let source = it["source"] as Source | undefined;
          if (!source || typeof source !== "object" || !source.type) {
            if (it["audio"] instanceof Blob) {
              source = {
                type: "file",
                blob: it["audio"] as Blob,
                name: (typeof it["title"] === "string" ? it["title"] : "audio") || "audio",
              };
            } else {
              source = {
                type: "file",
                blob: new Blob([]),
                name: (typeof it["title"] === "string" ? it["title"] : "audio") || "audio",
              };
            }
          }
          const cover = it["cover"] instanceof Blob ? (it["cover"] as Blob) : new Blob([]);
          const thumb =
            it["thumb"] instanceof Blob
              ? (it["thumb"] as Blob)
              : cover.size > 0
                ? cover
                : new Blob([]);

          return {
            id: String(it["id"] || crypto.randomUUID()),
            title: String(it["title"] || "Untitled"),
            order:
              typeof it["order"] === "number" && Number.isFinite(it["order"]) ? it["order"] : 0,
            cover,
            thumb,
            source,
          };
        });
      res(items.sort((a, b) => a.order - b.order));
    };
    r.onerror = () => rej(r.error);
  });
}

export const putItem = (item: Item) => run("readwrite", (s) => s.put(item));
export const removeItem = (id: string) => run("readwrite", (s) => s.delete(id));
export const saveOrder = (items: Item[]) =>
  run("readwrite", (s) => items.forEach((it, i) => s.put({ ...it, order: i })));

export function storageErrorMessage(e: unknown): string {
  const n = (e as DOMException)?.name;
  if (n === "QuotaExceededError") return "Storage full. Free space or use smaller files.";
  return "Could not save. Storage unavailable.";
}

export function requestPersistence() {
  navigator.storage?.persist?.().catch(() => {});
}
