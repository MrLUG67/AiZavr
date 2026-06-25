// Реестр LLM для уплотнения — отдельно от активного провайдера диалога.
import type { ChatMessage } from '../host/types';
import type { LlmProvider, LlmResponse } from './types';

let provider: LlmProvider | null = null;

export function registerCompressionProvider(p: LlmProvider | null): void {
  provider = p;
}

export function getCompressionProvider(): LlmProvider | null {
  return provider;
}

export async function callCompression(messages: ChatMessage[]): Promise<LlmResponse> {
  if (!provider?.isReady()) {
    throw new Error(
      'Модель уплотнения не настроена. Выберите провайдер и модель в виджете «Уплотнитель».',
    );
  }
  return provider.generateResponse(messages, 'compression');
}
