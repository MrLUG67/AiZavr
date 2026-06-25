// Инструкция (system) для LLM-уплотнения. Жёсткость регулируется в UI виджета.
export const DEFAULT_COMPRESSION_SYSTEM_PROMPT = `Сделай короткий пересказ диалога. Отрази принципиально важные моменты, факты, выводы. Убери все промежуточные рассуждения, преамбулы, связки и т.д. Вопросы пользователя не цитируй, но используй как основу канвы рассуждений. Объём выходного текста должен быть 25–30% от объёма исходного.

Сохрани дословно: блоки кода, числа, версии, идентификаторы.
Верни ТОЛЬКО текст пересказа, без преамбулы и пояснений.`;

/** Пустая или пробельная строка → дефолт. */
export function resolveSystemPrompt(raw: string): string {
  const t = raw.trim();
  return t || DEFAULT_COMPRESSION_SYSTEM_PROMPT;
}

export function buildCompressionMessages(
  transcript: string,
  systemPrompt: string,
): { role: 'system' | 'user'; content: string }[] {
  return [
    { role: 'system', content: resolveSystemPrompt(systemPrompt) },
    {
      role: 'user',
      content:
        `Ниже фрагмент беседы для сжатия (${transcript.length} симв.).\n\n` +
        transcript,
    },
  ];
}
