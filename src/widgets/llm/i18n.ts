import { t } from '../../i18n';

// Общие подписи формы LLM-плагинов (OpenRouter, Gemini). Ключи под namespace
// widgets.llm.* в центральных локалях; вызываются в момент сборки формы, чтобы
// смена языка (пересборка по @@lang) подхватывала перевод без перезапуска.
const PREFIX = 'widgets.llm.';

export function lt(key: string, params?: Record<string, string | number>): string {
  return t(`${PREFIX}${key}`, params);
}
