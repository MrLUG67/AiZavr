// Контракт LLM-провайдера (плагин регистрируется в реестре, ядро вызывает).
import type { ChatMessage, ModelFacts } from '../host/types';
import type { LlmMediaItem } from './mediaTypes';

export type { LlmMediaItem } from './mediaTypes';

export interface LlmResponse {
  content: string;
  modelId: string;
  tokensInput: number;
  tokensOutput: number;
  /** Картинки и прочие бинарные части ответа (если модель вернула). */
  media: LlmMediaItem[];
  /** Нефатальные предупреждения (например, вложение не поддержано моделью и
   *  было отброшено). Текст ответа при этом сохраняется. */
  warnings?: string[];
}

export interface LlmProvider {
  pluginId: string;
  isReady(): boolean;
  getModelFacts(): ModelFacts;
  generateResponse(
    messages: ChatMessage[],
    role: string,
  ): Promise<LlmResponse>;
  /** Человекочитаемое имя модели по её id (для метрики запросов). null если
   *  модель неизвестна провайдеру — потребитель покажет сам id. */
  getModelName?(modelId: string): string | null;
}
