import { t } from '../../i18n';

const PREFIX = 'widgets.openrouter.';

export function ct(key: string, params?: Record<string, string | number>): string {
  return t(`${PREFIX}${key}`, params);
}
