import { t } from '../../i18n';

const PREFIX = 'widgets.contextMeter.';

export function ct(key: string, params?: Record<string, string | number>): string {
  return t(`${PREFIX}${key}`, params);
}
