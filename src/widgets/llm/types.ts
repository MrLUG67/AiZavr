// Контракт LLM-провайдера (плагин регистрируется в реестре, ядро вызывает).
import type { ChatMessage, ModelFacts } from '../host/types';

export interface LlmResponse {
  content: string;
  modelId: string;
  tokensInput: number;
  tokensOutput: number;
}

export interface LlmProvider {
  pluginId: string;
  isReady(): boolean;
  getModelFacts(): ModelFacts;
  generateResponse(
    messages: ChatMessage[],
    role: string,
  ): Promise<LlmResponse>;
}
