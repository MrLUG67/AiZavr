import { t } from '../../i18n';

const PREFIX = 'widgets.tagger.';

export function ct(key: string, params?: Record<string, string | number>): string {
  return t(`${PREFIX}${key}`, params);
}

export function settingsIntro(): string[] {
  return [1, 2, 3, 4].map((i) => ct(`settings.intro.${i}`));
}
