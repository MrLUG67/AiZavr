// HTTP-клиент OpenRouter — живёт в плагине, не в ядре.
import type { ChatMessage, ChatMediaPart } from '../host/types';
import { ct } from './i18n';
import type { LlmResponse } from '../llm/types';
import { extractFromOpenAiContent } from '../llm/extractMedia';
import { capabilitiesFromOpenRouter } from '../llm/capabilities';
import {
  modelAcceptsKind,
  unsupportedWarning,
  toDataUrl,
  audioFormat,
} from '../llm/outgoingMedia';

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
  /** Сырые теги API (architecture.*_modalities). */
  inputModalities: string[];
  outputModalities: string[];
  /** Нормализованные in/out для фильтра и колонки «Комментарий». */
  capabilities: import('../host/types').ModelCapabilities;
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

export async function fetchModels(apiKey: string): Promise<OpenRouterModel[]> {
  const resp = await fetch(`${BASE}/models?output_modalities=all`, {
    headers: { Authorization: `Bearer ${apiKey}`, ...APP_HEADERS },
  });
  const body = await resp.text();
  if (!resp.ok) {
    throw new Error(`OpenRouter HTTP ${resp.status}: ${body}`);
  }
  const parsed: RawModelsResponse = JSON.parse(body);
  return (parsed.data ?? [])
    .map((m) => {
      const inputModalities = m.architecture?.input_modalities ?? [];
      const outputModalities = m.architecture?.output_modalities ?? ['text'];
      return {
        id: m.id,
        name: m.name ?? m.id,
        contextWindow: m.context_length ?? 128000,
        inputModalities,
        outputModalities,
        capabilities: capabilitiesFromOpenRouter(inputModalities, outputModalities),
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

// Преобразовать одну часть-вложение в элемент content[] OpenAI-формата.
function mediaToOpenAiPart(part: ChatMediaPart): Record<string, unknown> {
  if (part.kind === 'image') {
    return { type: 'image_url', image_url: { url: toDataUrl(part) } };
  }
  if (part.kind === 'audio') {
    return {
      type: 'input_audio',
      input_audio: { data: part.base64, format: audioFormat(part) },
    };
  }
  // document / video / прочее — как файл (OpenRouter передаёт file_data моделям
  // с файловым вводом).
  return {
    type: 'file',
    file: { filename: part.filename, file_data: toDataUrl(part) },
  };
}

// Собрать messages для OpenRouter: сообщения с media превращаем в content[]
// (text + части), гейтим по возможностям модели, копим предупреждения.
function buildMessages(
  messages: ChatMessage[],
  model?: OpenRouterModel,
): { messages: unknown[]; warnings: string[] } {
  const warnings: string[] = [];
  const out = messages.map((m) => {
    if (!m.media?.length) {
      return { role: m.role, content: m.content };
    }
    const parts: Record<string, unknown>[] = [];
    if (m.content) parts.push({ type: 'text', text: m.content });
    for (const part of m.media) {
      if (!modelAcceptsKind(model?.capabilities, part.kind)) {
        warnings.push(unsupportedWarning(part));
        continue;
      }
      parts.push(mediaToOpenAiPart(part));
    }
    // Все вложения отброшены — отправляем обычный текст.
    if (parts.length === 0) return { role: m.role, content: m.content };
    if (parts.length === 1 && (parts[0] as { type?: string }).type === 'text') {
      return { role: m.role, content: m.content };
    }
    return { role: m.role, content: parts };
  });
  return { messages: out, warnings };
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

  const { messages: builtMessages, warnings } = buildMessages(messages, model);

  const bodyPayload: Record<string, unknown> = {
    model: modelId,
    messages: builtMessages,
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
      throw new Error(ct('api.insufficientFunds'));
    }
    throw new Error(`OpenRouter HTTP ${resp.status}: ${body}`);
  }

  let parsed: RawChatResponse;
  try {
    parsed = JSON.parse(body);
  } catch {
    throw new Error(ct('api.parseFailed', { body }));
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
      ct('api.emptyResponse', { reason, model: modelId, body: body.slice(0, 500) }),
    );
  }

  // Ответ только картинкой, без текста — даём заголовок «Ответ:», чтобы плашки
  // не висели в пустом пузыре без подписи.
  const finalContent = content || ct('api.answerFallback');

  return {
    content: finalContent,
    media,
    modelId: parsed.model ?? modelId,
    tokensInput: parsed.usage?.prompt_tokens ?? 0,
    tokensOutput: parsed.usage?.completion_tokens ?? 0,
    ...(warnings.length > 0 ? { warnings } : {}),
  };
}
