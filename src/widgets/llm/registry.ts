// Реестр активных LLM-провайдеров. Плагины регистрируются при настройке;
// App вызывает generateResponse через getActiveLlmProvider().
import type { LlmProvider } from './types';

type Listener = () => void;

const LS_ACTIVE = 'aizavr.activeLlmProvider';

const providers = new Map<string, LlmProvider>();
const listeners = new Set<Listener>();

let activeId: string | null = readActiveId();

function readActiveId(): string | null {
  try {
    return localStorage.getItem(LS_ACTIVE);
  } catch {
    return null;
  }
}

export function registerLlmProvider(provider: LlmProvider): void {
  providers.set(provider.pluginId, provider);
  notify();
}

export function unregisterLlmProvider(pluginId: string): void {
  providers.delete(pluginId);
  notify();
}

export function getActiveLlmProviderId(): string | null {
  return activeId;
}

export function setActiveLlmProvider(pluginId: string | null): void {
  activeId = pluginId;
  try {
    if (pluginId) localStorage.setItem(LS_ACTIVE, pluginId);
    else localStorage.removeItem(LS_ACTIVE);
  } catch {
    /* ignore */
  }
  notify();
}

export function getActiveLlmProvider(): LlmProvider | null {
  if (!activeId) return null;
  return providers.get(activeId) ?? null;
}

export function subscribeLlmProvider(fn: Listener): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function notify(): void {
  listeners.forEach((fn) => fn());
}
