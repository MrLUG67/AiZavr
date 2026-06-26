// Реестр LLM для тегизатора — отдельно от активного провайдера диалога и от
// уплотнения (у каждого свой коннект/модель/промпт). Зеркало compressionRegistry.
import type { ChatMessage } from '../host/types';
import type { LlmProvider, LlmResponse } from './types';

let provider: LlmProvider | null = null;

export function registerTaggingProvider(p: LlmProvider | null): void {
  provider = p;
}

export function getTaggingProvider(): LlmProvider | null {
  return provider;
}

export async function callTagging(messages: ChatMessage[]): Promise<LlmResponse> {
  if (!provider?.isReady()) {
    throw new Error(
      'Модель тегизатора не настроена. Выберите провайдер и модель в виджете «Тегизатор».',
    );
  }
  return provider.generateResponse(messages, 'tagging');
}
