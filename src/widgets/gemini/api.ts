// HTTP-клиент Google Gemini (Generative Language API) — живёт в плагине, не в ядре.
// Ключ берётся бесплатно в Google AI Studio и привязан к гугл-аккаунту; у бесплатного
// тарифа есть лимиты запросов/минуту и в сутки — отсюда отдельная обработка 429.
import type { ChatMessage, ModelCapabilities } from '../host/types';
import type { LlmResponse } from '../llm/types';
import { extractFromGeminiParts } from '../llm/extractMedia';
import { capabilitiesFromGemini } from '../llm/capabilities';
import { modelAcceptsKind, unsupportedWarning } from '../llm/outgoingMedia';
import { DEFAULT_MAX_OUTPUT_TOKENS } from '../llm/pluginSettings';
import { ct } from './i18n';

const BASE = 'https://generativelanguage.googleapis.com/v1beta';

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
    return ct('api.rateLimit');
  }
  if (status === 400 && /API_KEY_INVALID|API key not valid/i.test(body)) {
    return ct('api.keyInvalid');
  }
  if (status === 403) {
    return ct('api.forbidden');
  }
  if (status === 503 || status === 500) {
    return ct('api.overloaded');
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

// Часть запроса Gemini: текст ИЛИ бинарные данные (inlineData).
type GeminiPart =
  | { text: string }
  | { inlineData: { mimeType: string; data: string } };

// Раскладываем диалог ядра в формат Gemini:
// - system-сообщения собираются в systemInstruction;
// - user → role "user", assistant → role "model";
// - вложения (media) → inlineData, с гейтингом по возможностям модели.
function toGeminiContents(
  messages: ChatMessage[],
  cap?: ModelCapabilities,
): {
  systemInstruction?: { parts: { text: string }[] };
  contents: { role: string; parts: GeminiPart[] }[];
  warnings: string[];
} {
  const systemTexts: string[] = [];
  const contents: { role: string; parts: GeminiPart[] }[] = [];
  const warnings: string[] = [];

  for (const m of messages) {
    if (m.role === 'system') {
      if (m.content.trim()) systemTexts.push(m.content);
      continue;
    }
    const parts: GeminiPart[] = [];
    if (m.content) parts.push({ text: m.content });
    for (const part of m.media ?? []) {
      if (!modelAcceptsKind(cap, part.kind)) {
        warnings.push(unsupportedWarning(part));
        continue;
      }
      parts.push({ inlineData: { mimeType: part.mime, data: part.base64 } });
    }
    if (parts.length === 0) parts.push({ text: m.content });
    contents.push({
      role: m.role === 'assistant' ? 'model' : 'user',
      parts,
    });
  }

  const out: {
    systemInstruction?: { parts: { text: string }[] };
    contents: { role: string; parts: GeminiPart[] }[];
    warnings: string[];
  } = { contents, warnings };

  if (systemTexts.length > 0) {
    out.systemInstruction = { parts: [{ text: systemTexts.join('\n\n') }] };
  }
  return out;
}

export async function chatCompletion(
  apiKey: string,
  modelId: string,
  messages: ChatMessage[],
  model?: GeminiModel,
  maxOutputTokens: number = DEFAULT_MAX_OUTPUT_TOKENS,
): Promise<LlmResponse> {
  const { systemInstruction, contents, warnings } = toGeminiContents(
    messages,
    model?.capabilities,
  );
  const wantsImage = /image/i.test(modelId);

  const generationConfig: Record<string, unknown> = {
    maxOutputTokens,
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
      throw new Error(ct('api.safetyBlocked'));
    }
    throw new Error(
      ct('api.emptyResponse', { reason, model: modelId, body: body.slice(0, 500) }),
    );
  }

  // Ответ только картинкой, без текста — даём заголовок «Ответ:», чтобы плашки
  // не висели в пустом пузыре без подписи.
  const finalContent = content || ct('api.answerFallback');

  return {
    content: finalContent,
    media,
    modelId: parsed.modelVersion ?? modelId,
    tokensInput: parsed.usageMetadata?.promptTokenCount ?? 0,
    tokensOutput: parsed.usageMetadata?.candidatesTokenCount ?? 0,
    ...(warnings.length > 0 ? { warnings } : {}),
  };
}
