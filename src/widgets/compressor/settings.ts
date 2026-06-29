import type { WidgetCapabilities, FormDoc, ControlNode } from '../host/types';
import { fetchModels as fetchOpenRouterModels } from '../openrouter/api';
import { fetchModels as fetchGeminiModels } from '../gemini/api';
import { defaultCompressionPrompt, resolveSystemPrompt } from './prompts';
import { ct, settingsIntro } from './i18n';
import { t } from '../../i18n';

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

// ---------------------------------------------------------------------------
// Декларативная форма настроек (D-096). Тот же контент, что прежний SettingsDoc,
// но как общая FormDoc: вкладки «Модель»/«Инструкция», радио провайдера,
// выпадашка модели, многострочный промпт. Состояние полей держит хост-модалка.
// ---------------------------------------------------------------------------

export async function buildSettingsForm(
  cap: WidgetCapabilities,
  config: CompressionConfig,
  models: { id: string; name: string }[],
  opts?: { loadingModels?: boolean; error?: string | null },
): Promise<FormDoc> {
  const readiness = await Promise.all(
    BACKENDS.map(async (id) => ({ id, ready: await providerReady(id, cap) })),
  );
  const readyMap = Object.fromEntries(readiness.map((r) => [r.id, r.ready]));
  const providerReadyNow = readyMap[config.backend] ?? false;
  const modelOptions = models.map((m) => ({ value: m.id, label: m.name }));

  const modelTab: ControlNode = {
    kind: 'stack',
    children: [
      {
        kind: 'field',
        label: t('app.settings.provider'),
        child: {
          kind: 'radioGroup',
          name: 'backend',
          value: config.backend,
          options: BACKENDS.map((id) => ({
            value: id,
            label: PROVIDER_LABELS[id] + (readyMap[id] ? '' : ` (${t('app.settings.noKey')})`),
          })),
          onChange: { type: 'FORM_PROVIDER' },
        },
      },
      {
        kind: 'field',
        label: t('app.settings.model'),
        child: {
          kind: 'select',
          name: 'modelId',
          value: config.modelId,
          disabled: opts?.loadingModels || !providerReadyNow,
          placeholder: opts?.loadingModels
            ? t('app.settings.loadingModels')
            : modelOptions.length === 0
              ? t('app.settings.noModels')
              : undefined,
          options: modelOptions,
        },
      },
    ],
  };

  const promptTab: ControlNode = {
    kind: 'stack',
    children: [
      {
        kind: 'field',
        label: t('app.settings.prompt'),
        child: {
          kind: 'textInput',
          name: 'systemPrompt',
          value: config.systemPrompt,
          multiline: true,
          rows: 10,
        },
      },
      {
        kind: 'button',
        label: t('app.settings.resetPrompt'),
        disabled: config.systemPrompt.trim() === defaultCompressionPrompt().trim(),
        onClick: { type: 'FORM_RESET_PROMPT' },
      },
    ],
  };

  return {
    widgetId: PLUGIN_ID,
    title: ct('settings.title'),
    submitLabel: t('app.settings.apply'),
    cancelLabel: t('app.settings.cancel'),
    submitMsg: { type: 'FORM_SUBMIT' },
    cancelMsg: { type: 'FORM_CANCEL' },
    busy: opts?.loadingModels,
    error: opts?.error ?? null,
    body: {
      kind: 'stack',
      children: [
        { kind: 'text', value: settingsIntro()[0], tone: 'muted' },
        {
          kind: 'tabs',
          tabs: [
            { id: 'model', label: ct('settings.tabModel'), child: modelTab },
            { id: 'prompt', label: ct('settings.tabPrompt'), child: promptTab },
          ],
        },
      ],
    },
  };
}

/** Собрать конфиг из снимка значений формы (D-096). prev — на случай пропусков. */
export function configFromValues(
  values: Record<string, string>,
  prev: CompressionConfig,
): CompressionConfig {
  const backend = (values.backend as BackendId) ?? prev.backend;
  return {
    backend,
    modelId: values.modelId ?? prev.modelId,
    systemPrompt: resolveSystemPrompt(values.systemPrompt ?? prev.systemPrompt),
  };
}
