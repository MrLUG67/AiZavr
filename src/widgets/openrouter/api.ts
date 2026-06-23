// HTTP-клиент OpenRouter — живёт в плагине, не в ядре.
import type { ChatMessage } from '../host/types';
import type { LlmResponse } from '../llm/types';

const BASE = 'https://openrouter.ai/api/v1';

const APP_HEADERS = {
  'HTTP-Referer': 'https://github.com/MrLUG67/AiZavr',
  'X-Title': 'AiZavr',
};

// Потолок длины ответа. Без него OpenRouter подставляет МАКСИМУМ модели (у Opus
// это 65536) и резервирует средства под весь объём — дорогие модели падают с
// HTTP 402 ещё до генерации. Разумный лимит ответа диалога снимает это и экономит
// баланс. Достаточно для развёрнутого ответа; при нужде можно поднять.
const MAX_OUTPUT_TOKENS = 4096;

export interface OpenRouterModel {
  id: string;
  name: string;
  contextWindow: number;
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

interface RawMessage {
  content?: unknown;
  reasoning?: string;
  refusal?: string;
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
    const parts = c
      .map((part) => {
        if (typeof part === 'string') return part;
        if (part && typeof part === 'object' && 'text' in part) {
          const t = (part as { text?: string }).text;
          return typeof t === 'string' ? t : '';
        }
        return '';
      })
      .filter(Boolean);
    if (parts.length > 0) return parts.join('\n');
  }

  if (typeof message.reasoning === 'string' && message.reasoning.trim()) {
    return message.reasoning;
  }

  if (typeof message.refusal === 'string' && message.refusal.trim()) {
    return message.refusal;
  }

  return '';
}

function isChatModel(m: RawModel): boolean {
  const out = m.architecture?.output_modalities;
  if (!out || out.length === 0) return true;
  return out.includes('text');
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
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

export async function chatCompletion(
  apiKey: string,
  modelId: string,
  messages: ChatMessage[],
): Promise<LlmResponse> {
  const resp = await fetch(`${BASE}/chat/completions`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
      ...APP_HEADERS,
    },
    body: JSON.stringify({
      model: modelId,
      messages,
      max_tokens: MAX_OUTPUT_TOKENS,
    }),
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
  if (!content) {
    const reason = choice?.finish_reason ?? 'unknown';
    throw new Error(
      `OpenRouter: пустой ответ (finish_reason=${reason}, model=${modelId}). Body: ${body.slice(0, 500)}`,
    );
  }

  return {
    content,
    modelId: parsed.model ?? modelId,
    tokensInput: parsed.usage?.prompt_tokens ?? 0,
    tokensOutput: parsed.usage?.completion_tokens ?? 0,
  };
}
