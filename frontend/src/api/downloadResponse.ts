export interface ApiDownload {
  blob: Blob;
  filename: string | null;
}

export function parseContentDispositionFilename(value: unknown): string | null {
  if (typeof value !== "string" || value.trim() === "") return null;

  const encoded = value.match(/filename\*\s*=\s*UTF-8''([^;]+)/i)?.[1];
  const fallback = value.match(/filename\s*=\s*(?:"([^"]+)"|([^;]+))/i);
  let filename = encoded ?? fallback?.[1] ?? fallback?.[2] ?? "";
  try {
    filename = encoded ? decodeURIComponent(filename.trim()) : filename.trim();
  } catch {
    return null;
  }
  filename = filename.split(/[\\/]/).pop() ?? "";
  filename = Array.from(filename)
    .filter((character) => {
      const codePoint = character.codePointAt(0) ?? 0;
      return codePoint > 31 && codePoint !== 127;
    })
    .join("");
  return filename || null;
}
