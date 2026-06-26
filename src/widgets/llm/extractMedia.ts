import type { LlmMediaItem } from './mediaTypes';
import { extensionFromMime, parseDataUrl } from './mediaTypes';

function pushMedia(out: LlmMediaItem[], mime: string, base64: string): void {
  const clean = base64.replace(/\s/g, '');
  if (!clean) return;
  out.push({
    mime,
    extension: extensionFromMime(mime),
    base64: clean,
  });
}

/** OpenAI/OpenRouter: content[] с text и image_url. */
export function extractFromOpenAiContent(content: unknown): {
  text: string;
  media: LlmMediaItem[];
} {
  const media: LlmMediaItem[] = [];
  if (typeof content === 'string') {
    return { text: content, media };
  }
  if (!Array.isArray(content)) {
    return { text: '', media };
  }

  const textParts: string[] = [];
  for (const part of content) {
    if (!part || typeof part !== 'object') continue;
    const p = part as Record<string, unknown>;
    const type = p.type;

    if (type === 'text' && typeof p.text === 'string') {
      textParts.push(p.text);
      continue;
    }

    if (type === 'image_url') {
      const iu = p.image_url as { url?: string } | undefined;
      const url = iu?.url;
      if (typeof url === 'string') {
        if (url.startsWith('data:')) {
          const parsed = parseDataUrl(url);
          if (parsed) pushMedia(media, parsed.mime, parsed.base64);
        }
        // http(s) URL — пока не скачиваем; позже.
      }
      continue;
    }

    // Некоторые провайдеры: { type: 'image', source: { data, media_type } }
    if (type === 'image') {
      const source = p.source as { data?: string; media_type?: string } | undefined;
      if (source?.data && source.media_type) {
        pushMedia(media, source.media_type, source.data);
      }
    }
  }

  return { text: textParts.join('\n').trim(), media };
}

/** Gemini generateContent: parts[] с text и inlineData. */
export function extractFromGeminiParts(
  parts: { text?: string; inlineData?: { mimeType?: string; data?: string } }[],
): { text: string; media: LlmMediaItem[] } {
  const media: LlmMediaItem[] = [];
  const textParts: string[] = [];

  for (const p of parts) {
    if (p.text) textParts.push(p.text);
    if (p.inlineData?.data && p.inlineData.mimeType) {
      pushMedia(media, p.inlineData.mimeType, p.inlineData.data);
    }
  }

  return { text: textParts.join('\n').trim(), media };
}
