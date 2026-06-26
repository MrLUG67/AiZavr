// Медиа-вложения в ответе LLM (картинки и т.д.) — общий контракт провайдеров.

export interface LlmMediaItem {
  mime: string;
  extension: string;
  /** Base64 без префикса data:… */
  base64: string;
}

export function extensionFromMime(mime: string): string {
  const m = mime.toLowerCase().split(';')[0].trim();
  const map: Record<string, string> = {
    'image/png': 'png',
    'image/jpeg': 'jpg',
    'image/jpg': 'jpg',
    'image/webp': 'webp',
    'image/gif': 'gif',
    'image/bmp': 'bmp',
    'image/svg+xml': 'svg',
  };
  return map[m] ?? 'bin';
}

/** data:image/png;base64,AAAA… → { mime, base64 } */
export function parseDataUrl(url: string): { mime: string; base64: string } | null {
  const m = url.match(/^data:([^;,]+);base64,(.+)$/is);
  if (!m) return null;
  return { mime: m[1], base64: m[2].replace(/\s/g, '') };
}
