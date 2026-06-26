import { ct } from './i18n';

/** Дефолтная инструкция для LLM — зависит от языка UI. */
export function defaultCompressionPrompt(): string {
  return ct('prompt.default');
}

/** Пустая или пробельная строка → дефолт текущего языка. */
export function resolveSystemPrompt(raw: string): string {
  const trimmed = raw.trim();
  return trimmed || defaultCompressionPrompt();
}

export function buildCompressionMessages(
  transcript: string,
  systemPrompt: string,
): { role: 'system' | 'user'; content: string }[] {
  return [
    { role: 'system', content: resolveSystemPrompt(systemPrompt) },
    {
      role: 'user',
      content: ct('prompt.userPrefix', { count: transcript.length }) + transcript,
    },
  ];
}
