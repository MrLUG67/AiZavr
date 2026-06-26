import type { WidgetCapabilities, SettingsDoc } from '../host/types';
import { fetchModels as fetchOpenRouterModels } from '../openrouter/api';
import { fetchModels as fetchGeminiModels } from '../gemini/api';
import { defaultCompressionPrompt, resolveSystemPrompt } from './prompts';
import { ct, settingsIntro } from './i18n';

export const PLUGIN_ID = 'compressor';

export type BackendId = 'openrouter' | 'gemini';

export interface CompressionConfig {
  backend: BackendId;
  modelId: string;
  systemPrompt: string;
}

export const DEFAULT_PROVIDER: BackendId = 'openrouter';

export const DEFAULT_MODELS: Record<BackendId, string> = {
  openrouter: 'anthropic/claude-haiku-4-5',
  gemini: 'gemini-2.5-flash',
};

export const PROVIDER_LABELS: Record<BackendId, string> = {
  openrouter: 'OpenRouter',
  gemini: 'Gemini',
};

export const BACKENDS: BackendId[] = ['openrouter', 'gemini'];

export async function providerReady(
  backend: BackendId,
  cap: WidgetCapabilities,
): Promise<boolean> {
  const key = await cap.secrets.get(backend);
  return !!key;
}

export async function loadModelsForBackend(
  backend: BackendId,
  cap: WidgetCapabilities,
): Promise<{ models: { id: string; name: string }[]; error: string | null }> {
  const apiKey = await cap.secrets.get(backend);
  if (!apiKey) {
    return { models: [], error: ct('error.providerNoKey') };
  }
  try {
    if (backend === 'gemini') {
      return { models: await fetchGeminiModels(apiKey), error: null };
    }
    return { models: await fetchOpenRouterModels(apiKey), error: null };
  } catch (e) {
    return { models: [], error: String(e) };
  }
}

export async function buildSettingsDoc(
  cap: WidgetCapabilities,
  config: CompressionConfig,
  models: { id: string; name: string }[],
  opts?: { loadingModels?: boolean; error?: string | null },
): Promise<SettingsDoc> {
  const readiness = await Promise.all(
    BACKENDS.map(async (id) => ({ id, ready: await providerReady(id, cap) })),
  );
  const readyMap = Object.fromEntries(readiness.map((r) => [r.id, r.ready]));

  return {
    widgetId: PLUGIN_ID,
    title: ct('settings.title'),
    intro: settingsIntro(),
    providerId: config.backend,
    providers: BACKENDS.map((id) => ({
      id,
      label: PROVIDER_LABELS[id],
      ready: readyMap[id] ?? false,
    })),
    modelId: config.modelId,
    models: models.map((m) => ({ id: m.id, label: m.name })),
    prompt: config.systemPrompt,
    defaultPrompt: defaultCompressionPrompt(),
    loadingModels: opts?.loadingModels,
    error: opts?.error ?? null,
  };
}

export function configFromSettingsDoc(doc: SettingsDoc): CompressionConfig {
  return {
    backend: doc.providerId as BackendId,
    modelId: doc.modelId,
    systemPrompt: resolveSystemPrompt(doc.prompt),
  };
}
