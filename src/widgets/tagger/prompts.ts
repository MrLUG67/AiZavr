import type { ChatMessage } from '../host/types';
import { ct } from './i18n';

/** Дефолтная инструкция тегизатора — зависит от языка UI. */
export function defaultTaggingPrompt(): string {
  return ct('prompt.default');
}

/** Пустая или пробельная строка → дефолт текущего языка. */
export function resolveSystemPrompt(raw: string): string {
  const trimmed = raw.trim();
  return trimmed || defaultTaggingPrompt();
}

const MAX_TAGS = 6;

/**
 * Сообщения для извлечения тегов: справочник существующих тегов — в подсказку,
 * транскрипт диапазона — в тело. Ответ модели ждём CSV (см. парсер ниже).
 */
export function buildTaggingMessages(
  transcript: string,
  systemPrompt: string,
  dictionary: string[],
): ChatMessage[] {
  const dict = dictionary.join(', ');
  return [
    { role: 'system', content: resolveSystemPrompt(systemPrompt) },
    {
      role: 'user',
      content:
        ct('prompt.dictionary', { dict: dict || ct('prompt.emptyDict') }) +
        '\n\n' +
        ct('prompt.userPrefix', { count: transcript.length }) +
        transcript,
    },
  ];
}

/**
 * Разбор CSV-ответа модели в список display-имён: режем по запятым/строкам,
 * чистим '#', дедуп без учёта регистра, отсекаем мусор, ограничиваем число.
 */
export function parseTagCsv(raw: string): string[] {
  const parts = raw.split(/[\n,;]+/g);
  const out: string[] = [];
  const seen = new Set<string>();
  for (const part of parts) {
    const cleaned = part.trim().replace(/^#+/, '').trim();
    if (!cleaned) continue;
    if (cleaned.length > 40) continue; // вероятно фраза/пояснение, не тег
    const key = cleaned.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(cleaned);
    if (out.length >= MAX_TAGS) break;
  }
  return out;
}
