// Реестр LLM-провайдеров. Два НЕЗАВИСИМЫХ понятия (расцеплены намеренно):
//   - ЗАРЕГИСТРИРОВАН = плагин готов к работе (есть валидный ключ + модель).
//     Регистрирует САМ плагин (у него доступ к ключу), как только готов.
//   - АКТИВЕН = именно этот провайдер обрабатывает диалог. Выбирает ядро/хедер.
// Инвариант: активным может быть ТОЛЬКО зарегистрированный (готовый) провайдер.
// Если активный провайдер перестал быть готовым (снят/невалиден ключ) —
// активность сбрасывается, чтобы не было коллизий.
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

function persistActiveId(id: string | null): void {
  try {
    if (id) localStorage.setItem(LS_ACTIVE, id);
    else localStorage.removeItem(LS_ACTIVE);
  } catch {
    /* ignore */
  }
}

export function registerLlmProvider(provider: LlmProvider): void {
  providers.set(provider.pluginId, provider);
  notify();
}

export function unregisterLlmProvider(pluginId: string): void {
  providers.delete(pluginId);
  // Инвариант: активный обязан быть готовым. Снятый с регистрации провайдер
  // больше не готов -> если он был активным, сбрасываем активность.
  if (activeId === pluginId) {
    activeId = null;
    persistActiveId(null);
  }
  notify();
}

/** id всех ГОТОВЫХ (зарегистрированных) провайдеров. */
export function getRegisteredLlmProviderIds(): string[] {
  return Array.from(providers.keys());
}

export function isLlmProviderReady(pluginId: string): boolean {
  return providers.has(pluginId);
}

export function getActiveLlmProviderId(): string | null {
  return activeId;
}

/**
 * Сделать провайдера активным. Защита от коллизий: выбрать можно ТОЛЬКО готового
 * (зарегистрированного). Попытка выбрать неготового игнорируется (radio не
 * перейдёт). null — снять активность.
 */
export function setActiveLlmProvider(pluginId: string | null): boolean {
  if (pluginId !== null && !providers.has(pluginId)) {
    return false; // неготовый — выбор отклонён
  }
  activeId = pluginId;
  persistActiveId(pluginId);
  notify();
  return true;
}

export function getActiveLlmProvider(): LlmProvider | null {
  if (!activeId) return null;
  return providers.get(activeId) ?? null;
}

// Человекочитаемое имя модели по id через активного провайдера. Если провайдер
// имя не знает (или его нет) — возвращаем сам id, чтобы строка метрики не пустела.
export function resolveModelName(modelId: string): string {
  if (!modelId) return modelId;
  const provider = getActiveLlmProvider();
  return provider?.getModelName?.(modelId) ?? modelId;
}

export function subscribeLlmProvider(fn: Listener): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function notify(): void {
  listeners.forEach((fn) => fn());
}
