// HTTP-клиент OpenRouter — живёт в плагине, не в ядре.
import type { ChatMessage } from '../host/types';
import type { LlmResponse } from '../llm/types';
import { extractFromOpenAiContent } from '../llm/extractMedia';

const BASE = 'https://openrouter.ai/api/v1';

const APP_HEADERS = {
  'HTTP-Referer': 'https://github.com/MrLUG67/AiZavr',
  'X-Title': 'AiZavr',
};

const MAX_OUTPUT_TOKENS = 4096;

export interface OpenRouterModel {
  id: string;
  name: string;
  contextWindow: number;
  outputModalities: string[];
}

interface RawModel {
  id: string;
  name?: string;
  context_length?: number;
  architecture?: {
    output_modalities?: string[];
    input_modalities?: string[];
  };
}

interface RawModelsResponse {
  data?: RawModel[];
}

interface RawUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
}

interface RawImage {
  type?: string;
  image_url?: { url?: string };
}

interface RawMessage {
  content?: unknown;
  reasoning?: string;
  refusal?: string;
  // OpenRouter отдаёт СГЕНЕРИРОВАННЫЕ картинки здесь, а НЕ в content.
  images?: RawImage[];
}

interface RawChatResponse {
  choices?: { message?: RawMessage; finish_reason?: string }[];
  model?: string;
  usage?: RawUsage;
  error?: { message?: string };
}

function extractMessageText(message: RawMessage | undefined): string {
  if (!message) return '';

  const c = message.content;
  if (typeof c === 'string' && c.trim()) return c;

  if (Array.isArray(c)) {
    const { text } = extractFromOpenAiContent(c);
    if (text) return text;
  }

  if (typeof message.reasoning === 'string' && message.reasoning.trim()) {
    return message.reasoning;
  }

  if (typeof message.refusal === 'string' && message.refusal.trim()) {
    return message.refusal;
  }

  return '';
}

function extractMessageMedia(message: RawMessage | undefined) {
  if (!message) return [];

  const media = [] as ReturnType<typeof extractFromOpenAiContent>['media'];

  // 1) Картинки в content[] (некоторые провайдеры/мультимодальные ответы).
  if (Array.isArray(message.content)) {
    media.push(...extractFromOpenAiContent(message.content).media);
  }

  // 2) Основной путь для image-моделей OpenRouter: message.images[].
  if (Array.isArray(message.images)) {
    const asContent = message.images
      .filter((img) => img?.image_url?.url)
      .map((img) => ({
        type: 'image_url',
        image_url: { url: img.image_url!.url as string },
      }));
    media.push(...extractFromOpenAiContent(asContent).media);
  }

  return media;
}

function isChatModel(m: RawModel): boolean {
  const out = m.architecture?.output_modalities;
  if (!out || out.length === 0) return true;
  return out.includes('text') || out.includes('image');
}

export async function fetchModels(apiKey: string): Promise<OpenRouterModel[]> {
  const resp = await fetch(`${BASE}/models`, {
    headers: { Authorization: `Bearer ${apiKey}`, ...APP_HEADERS },
  });
  const body = await resp.text();
  if (!resp.ok) {
    throw new Error(`OpenRouter HTTP ${resp.status}: ${body}`);
  }
  const parsed: RawModelsResponse = JSON.parse(body);
  return (parsed.data ?? [])
    .filter(isChatModel)
    .map((m) => ({
      id: m.id,
      name: m.name ?? m.id,
      contextWindow: m.context_length ?? 128000,
      outputModalities: m.architecture?.output_modalities ?? ['text'],
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

export async function chatCompletion(
  apiKey: string,
  modelId: string,
  messages: ChatMessage[],
  model?: OpenRouterModel,
): Promise<LlmResponse> {
  const wantsImage =
    model?.outputModalities?.includes('image') ??
    /image/i.test(modelId);

  const bodyPayload: Record<string, unknown> = {
    model: modelId,
    messages,
    max_tokens: MAX_OUTPUT_TOKENS,
  };
  if (wantsImage) {
    bodyPayload.modalities = ['text', 'image'];
  }

  const resp = await fetch(`${BASE}/chat/completions`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
      ...APP_HEADERS,
    },
    body: JSON.stringify(bodyPayload),
  });

  const body = await resp.text();
  if (!resp.ok) {
    if (resp.status === 402) {
      throw new Error(
        'Недостаточно средств для работы с данной моделью. ' +
          'Пополните баланс OpenRouter или выберите более дешёвую модель.',
      );
    }
    throw new Error(`OpenRouter HTTP ${resp.status}: ${body}`);
  }

  let parsed: RawChatResponse;
  try {
    parsed = JSON.parse(body);
  } catch {
    throw new Error(`OpenRouter: не удалось разобрать ответ. Body: ${body}`);
  }

  if (parsed.error?.message) {
    throw new Error(parsed.error.message);
  }

  const choice = parsed.choices?.[0];
  const content = extractMessageText(choice?.message);
  const media = extractMessageMedia(choice?.message);

  const rawImages = Array.isArray(choice?.message?.images)
    ? choice!.message!.images!.length
    : 0;
  console.log(
    `OpenRouter[${modelId}]: finish=${choice?.finish_reason ?? '?'} ` +
      `images_field=${rawImages} parsed_media=${media.length} text_len=${content.length}`,
  );

  if (!content && media.length === 0) {
    const reason = choice?.finish_reason ?? 'unknown';
    throw new Error(
      `OpenRouter: пустой ответ (finish_reason=${reason}, model=${modelId}). Body: ${body.slice(0, 500)}`,
    );
  }

  // Ответ только картинкой, без текста — даём заголовок «Ответ:», чтобы плашки
  // не висели в пустом пузыре без подписи.
  const finalContent = content || 'Ответ:';

  return {
    content: finalContent,
    media,
    modelId: parsed.model ?? modelId,
    tokensInput: parsed.usage?.prompt_tokens ?? 0,
    tokensOutput: parsed.usage?.completion_tokens ?? 0,
  };
}
