async function resize(file: Blob, max: number, type: string, q: number): Promise<Blob> {
  const bmp = await createImageBitmap(file);
  try {
    const s = Math.min(1, max / Math.max(bmp.width, bmp.height));
    if (s === 1 && max > 1000 && file.size < 3_000_000) return file;
    const c = document.createElement("canvas");
    c.width = Math.round(bmp.width * s);
    c.height = Math.round(bmp.height * s);
    c.getContext("2d")!.drawImage(bmp, 0, 0, c.width, c.height);
    return await new Promise<Blob>((res, rej) =>
      c.toBlob((b) => (b ? res(b) : rej(new Error("encode"))), type, q),
    );
  } finally {
    bmp.close();
  }
}

/** Returns a display-size cover and a small gallery thumbnail. */
export async function processImage(file: File): Promise<{ cover: Blob; thumb: Blob }> {
  if (!file.type.startsWith("image/")) throw new Error("Not an image.");
  try {
    const cover = await resize(file, 2400, "image/jpeg", 0.9);
    const thumb = await resize(file, 640, "image/webp", 0.82);
    return { cover, thumb };
  } catch {
    throw new Error("Image can't be read.");
  }
}

/** Confirms the browser can actually decode/play the audio file. */
export function checkAudio(file: File): Promise<void> {
  return new Promise((res, rej) => {
    if (file.type && !file.type.startsWith("audio/") && !file.type.startsWith("video/"))
      return rej(new Error("Not an audio file."));
    const url = URL.createObjectURL(file);
    const a = new Audio();
    const done = (err?: string) => {
      clearTimeout(t);
      a.removeAttribute("src");
      a.load();
      URL.revokeObjectURL(url);
      if (err) {
        rej(new Error(err));
      } else {
        res();
      }
    };
    const t = setTimeout(() => done("Audio can't be read."), 10000);
    a.preload = "metadata";
    a.onloadedmetadata = () => (a.duration > 0 ? done() : done("Audio is empty."));
    a.onerror = () => done("Unsupported audio format.");
    a.src = url;
  });
}
