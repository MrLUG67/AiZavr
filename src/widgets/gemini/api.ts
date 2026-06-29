// HTTP-клиент Google Gemini (Generative Language API) — живёт в плагине, не в ядре.
// Ключ берётся бесплатно в Google AI Studio и привязан к гугл-аккаунту; у бесплатного
// тарифа есть лимиты запросов/минуту и в сутки — отсюда отдельная обработка 429.
import type { ChatMessage, ModelCapabilities } from '../host/types';
import type { LlmResponse } from '../llm/types';
import { extractFromGeminiParts } from '../llm/extractMedia';
import { capabilitiesFromGemini } from '../llm/capabilities';

const BASE = 'https://generativelanguage.googleapis.com/v1beta';

// Потолок длины ответа (как у OpenRouter-плагина): не даём модели резервировать
// весь outputTokenLimit, экономим бесплатную квоту. Достаточно для развёрнутого
// ответа; при нужде поднимается.
const MAX_OUTPUT_TOKENS = 4096;

export interface GeminiModel {
  id: string; // без префикса "models/", напр. "gemini-2.5-flash"
  name: string; // человекочитаемое (displayName) или id
  contextWindow: number;
  /** Сырые методы API (для отладки/будущих эвристик). */
  supportedGenerationMethods: string[];
  /** Нормализованные in/out для фильтра модальностей (эвристика). */
  capabilities: ModelCapabilities;
}

interface RawModel {
  name?: string; // "models/gemini-2.5-flash"
  displayName?: string;
  inputTokenLimit?: number;
  supportedGenerationMethods?: string[];
}

interface RawModelsResponse {
  models?: RawModel[];
  nextPageToken?: string;
  error?: { message?: string };
}

interface RawPart {
  text?: string;
  inlineData?: { mimeType?: string; data?: string };
}

interface RawCandidate {
  content?: { parts?: RawPart[]; role?: string };
  finishReason?: string;
}

interface RawUsage {
  promptTokenCount?: number;
  candidatesTokenCount?: number;
}

interface RawGenerateResponse {
  candidates?: RawCandidate[];
  usageMetadata?: RawUsage;
  modelVersion?: string;
  error?: { message?: string };
}

// "models/gemini-2.5-flash" -> "gemini-2.5-flash"
function stripPrefix(name: string): string {
  return name.startsWith('models/') ? name.slice('models/'.length) : name;
}

// Каталог отдаём ПОЛНОСТЬЮ (как у OpenRouter): не-текстовые модели (озвучка,
// генерация картинок/видео, эмбеддинги) тоже нужны — до них «надо добраться» в
// оркестровке. Отсев под конкретную задачу делает фильтр модальностей в UI, а
// пригодность для диалога определяет плагин по capabilities.out.txt. Оставляем
// только модели с хоть какими-то методами генерации/эмбеддинга.
function isUsableModel(m: RawModel): boolean {
  const methods = m.supportedGenerationMethods;
  return !!methods && methods.length > 0;
}

function friendlyError(status: number, body: string): string {
  if (status === 429) {
    return (
      'Превышен бесплатный лимит Gemini (запросов в минуту/сутки). ' +
      'Подождите немного и попробуйте снова или выберите другую модель.'
    );
  }
  if (status === 400 && /API_KEY_INVALID|API key not valid/i.test(body)) {
    return 'API-ключ Gemini недействителен. Проверьте ключ в настройках.';
  }
  if (status === 403) {
    return 'Доступ запрещён (403). Проверьте, что ключ активен и API включён.';
  }
  if (status === 503 || status === 500) {
    return (
      'Модель Gemini сейчас перегружена на стороне Google (бесплатный тариф). ' +
      'Это временно — попробуйте через минуту или выберите модель полегче (flash/flash-lite).'
    );
  }
  return `Gemini HTTP ${status}: ${body}`;
}

// Серверная перегрузка (503/500) у бесплатного тарифа — частая и transient.
// Тихо повторяем запрос несколько раз с нарастающей паузой, прежде чем сдаться.
// 429 НЕ ретраим: это квота, повтор только усугубит.
const RETRY_STATUSES = new Set([500, 503]);
const RETRY_DELAYS_MS = [800, 2000, 4000];

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function fetchModels(apiKey: string): Promise<GeminiModel[]> {
  const resp = await fetch(`${BASE}/models?pageSize=200`, {
    headers: { 'x-goog-api-key': apiKey },
  });
  const body = await resp.text();
  if (!resp.ok) {
    throw new Error(friendlyError(resp.status, body));
  }
  let parsed: RawModelsResponse;
  try {
    parsed = JSON.parse(body);
  } catch {
    throw new Error(`Gemini: не удалось разобрать список моделей. Body: ${body}`);
  }
  if (parsed.error?.message) {
    throw new Error(parsed.error.message);
  }
  return (parsed.models ?? [])
    .filter(isUsableModel)
    .map((m) => {
      const full = m.name ?? '';
      const id = stripPrefix(full);
      const methods = m.supportedGenerationMethods ?? [];
      return {
        id,
        name: m.displayName ?? id,
        contextWindow: m.inputTokenLimit ?? 1_000_000,
        supportedGenerationMethods: methods,
        capabilities: capabilitiesFromGemini(id, methods),
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

// Раскладываем диалог ядра в формат Gemini:
// - system-сообщения собираются в systemInstruction;
// - user → role "user", assistant → role "model".
function toGeminiContents(messages: ChatMessage[]): {
  systemInstruction?: { parts: { text: string }[] };
  contents: { role: string; parts: { text: string }[] }[];
} {
  const systemTexts: string[] = [];
  const contents: { role: string; parts: { text: string }[] }[] = [];

  for (const m of messages) {
    if (m.role === 'system') {
      if (m.content.trim()) systemTexts.push(m.content);
      continue;
    }
    contents.push({
      role: m.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: m.content }],
    });
  }

  const out: {
    systemInstruction?: { parts: { text: string }[] };
    contents: { role: string; parts: { text: string }[] }[];
  } = { contents };

  if (systemTexts.length > 0) {
    out.systemInstruction = { parts: [{ text: systemTexts.join('\n\n') }] };
  }
  return out;
}

export async function chatCompletion(
  apiKey: string,
  modelId: string,
  messages: ChatMessage[],
): Promise<LlmResponse> {
  const { systemInstruction, contents } = toGeminiContents(messages);
  const wantsImage = /image/i.test(modelId);

  const generationConfig: Record<string, unknown> = {
    maxOutputTokens: MAX_OUTPUT_TOKENS,
  };
  if (wantsImage) {
    generationConfig.responseModalities = ['TEXT', 'IMAGE'];
  }

  const payload = JSON.stringify({
    ...(systemInstruction ? { systemInstruction } : {}),
    contents,
    generationConfig,
  });

  let resp: Response;
  let body: string;
  let attempt = 0;
  // attempt 0 = первая попытка; далее повторы по RETRY_DELAYS_MS на 503/500.
  for (;;) {
    resp = await fetch(`${BASE}/models/${modelId}:generateContent`, {
      method: 'POST',
      headers: {
        'x-goog-api-key': apiKey,
        'Content-Type': 'application/json',
      },
      body: payload,
    });
    body = await resp.text();
    if (resp.ok) break;
    if (RETRY_STATUSES.has(resp.status) && attempt < RETRY_DELAYS_MS.length) {
      await sleep(RETRY_DELAYS_MS[attempt]);
      attempt += 1;
      continue;
    }
    throw new Error(friendlyError(resp.status, body));
  }

  let parsed: RawGenerateResponse;
  try {
    parsed = JSON.parse(body);
  } catch {
    throw new Error(`Gemini: не удалось разобрать ответ. Body: ${body}`);
  }

  if (parsed.error?.message) {
    throw new Error(parsed.error.message);
  }

  const candidate = parsed.candidates?.[0];
  const parts = (candidate?.content?.parts ?? []) as RawPart[];
  const { text: content, media } = extractFromGeminiParts(parts);

  if (!content && media.length === 0) {
    const reason = candidate?.finishReason ?? 'unknown';
    if (reason === 'SAFETY' || reason === 'PROHIBITED_CONTENT') {
      throw new Error(
        'Gemini заблокировал ответ по правилам безопасности. Переформулируйте запрос.',
      );
    }
    throw new Error(
      `Gemini: пустой ответ (finishReason=${reason}, model=${modelId}). Body: ${body.slice(0, 500)}`,
    );
  }

  // Ответ только картинкой, без текста — даём заголовок «Ответ:», чтобы плашки
  // не висели в пустом пузыре без подписи.
  const finalContent = content || 'Ответ:';

  return {
    content: finalContent,
    media,
    modelId: parsed.modelVersion ?? modelId,
    tokensInput: parsed.usageMetadata?.promptTokenCount ?? 0,
    tokensOutput: parsed.usageMetadata?.candidatesTokenCount ?? 0,
  };
}
