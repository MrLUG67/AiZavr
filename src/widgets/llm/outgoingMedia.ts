// Гейтинг исходящих вложений по возможностям модели + единые предупреждения.
// Используется провайдерами (OpenRouter/Gemini) при сборке мультимодального
// запроса: модель, не принимающая данный тип на вход, его не получит, а
// пользователь увидит нефатальное предупреждение.

import type { ChatMediaPart, ModelCapabilities } from '../host/types';

/** Принимает ли модель данный тип вложения на ВХОД. */
export function modelAcceptsKind(
  cap: ModelCapabilities | undefined,
  kind: ChatMediaPart['kind'],
): boolean {
  // Без данных о возможностях ведём себя консервативно: пускаем только картинки
  // (поддержаны почти всеми мультимодальными моделями), остальное — предупреждаем.
  if (!cap) return kind === 'image';
  switch (kind) {
    case 'image':
      return cap.in.img;
    case 'audio':
      return cap.in.aud;
    case 'video':
      return cap.in.vid;
    // У нас нет отдельной категории «документ»: на входе провайдеры маппят
    // файловый ввод в img (OpenRouter 'file' → img; Gemini PDF — inlineData у
    // мультимодальных). Используем img как прокси.
    case 'document':
      return cap.in.img;
    default:
      return false;
  }
}

export function unsupportedWarning(part: ChatMediaPart): string {
  return `Файл «${part.filename}» не поддерживается выбранной моделью на вход и не был отправлен.`;
}

/** data:<mime>;base64,<data> для image_url / file_data. */
export function toDataUrl(part: ChatMediaPart): string {
  return `data:${part.mime};base64,${part.base64}`;
}

/** Формат для OpenAI input_audio (ожидает 'mp3' | 'wav' и т.п.). */
export function audioFormat(part: ChatMediaPart): string {
  const e = part.extension.replace(/^\./, '').toLowerCase();
  if (e === 'mpeg' || e === 'mpga') return 'mp3';
  return e || 'mp3';
}
