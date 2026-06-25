// Тонкий слой локализации фронта (i18n). Решение сессии 11:
//   - перевод живёт ТОЛЬКО на фронте, ядро языка не знает;
//   - строки вынесены в JSON-локали (ключи = алиасы);
//   - смена языка — без перезапуска: меняем язык -> уведомляем подписчиков ->
//     React-компоненты, дёрнувшие useLang(), перерисовываются.
//
// Автодискавери языков: список собирается из ВСЕХ файлов src/i18n/locales/*.json
// на сборке (import.meta.glob). Добавить язык = положить новый JSON в эту папку
// и прописать ВНУТРИ него служебные ключи `_lang.code` и `_lang.name`. Править
// этот файл при добавлении языка НЕ нужно — меню само подхватит новый язык.
//
// Множественное число НЕ разруливаем правилами: где в русском «ветки», там в
// английском просто branch(es) — дословная подстановка, по договорённости.
// Плагины (widgets/*) сюда НЕ входят — у них будут свои файлы локалей позже.

import { useEffect, useReducer } from "react";

export type Lang = string;

type Dict = Record<string, string>;

export interface LocaleInfo {
  code: string; // "ru", "en", "it"…
  name: string; // самоназвание языка для меню ("Русский", "English"…)
}

// Служебные ключи внутри каждого JSON (не показываются как обычный текст).
const META_CODE = "_lang.code";
const META_NAME = "_lang.name";

// Сборочное обнаружение всех локалей в папке. Vite заинлайнит JSON'ы в бандл —
// отдельная регистрация языков не нужна.
const modules = import.meta.glob<{ default: Dict }>("./locales/*.json", {
  eager: true,
});

const DICTS: Record<Lang, Dict> = {};
const NAMES: Record<Lang, string> = {};

for (const path in modules) {
  const dict = modules[path].default;
  // Код языка: из служебного ключа, иначе из имени файла (./locales/ru.json -> ru).
  const fileCode = path.split("/").pop()!.replace(/\.json$/, "");
  const code = dict[META_CODE] || fileCode;
  DICTS[code] = dict;
  NAMES[code] = dict[META_NAME] || code;
}

// Язык-резерв для отсутствующих ключей: русский, если он есть; иначе любой
// первый обнаруженный (чтобы не упасть, если ru.json удалят).
const FALLBACK: Lang = DICTS.ru ? "ru" : Object.keys(DICTS)[0] ?? "ru";

const LS_LANG = "aizavr.lang";

function detectLang(): Lang {
  try {
    const saved = localStorage.getItem(LS_LANG);
    if (saved && DICTS[saved]) return saved;
  } catch {}
  // Системная локаль: ищем язык, чей код совпадает с её префиксом (ru-RU -> ru).
  const sys = (navigator.language || "").toLowerCase();
  const match = Object.keys(DICTS).find((code) => sys.startsWith(code));
  return match ?? FALLBACK;
}

let currentLang: Lang = detectLang();

// Подписчики на смену языка (React-компоненты через useLang()).
const listeners = new Set<() => void>();

// Проставляем атрибут <html lang> сразу при загрузке модуля (до отрисовки).
try {
  document.documentElement.setAttribute("lang", currentLang);
} catch {}

export function getLang(): Lang {
  return currentLang;
}

// Список доступных языков для меню (отсортирован по самоназванию).
export function availableLocales(): LocaleInfo[] {
  return Object.keys(DICTS)
    .map((code) => ({ code, name: NAMES[code] }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

export function setLang(lang: Lang): void {
  if (lang === currentLang || !DICTS[lang]) return;
  currentLang = lang;
  try {
    localStorage.setItem(LS_LANG, lang);
  } catch {}
  try {
    document.documentElement.setAttribute("lang", lang);
  } catch {}
  listeners.forEach((fn) => fn());
}

// Перевод по ключу. params — подстановки вида {name} в строке локали.
// Порядок поиска: текущий язык -> резервный -> сам ключ (видно в UI, что забыли
// перевести).
export function t(key: string, params?: Record<string, string | number>): string {
  const dict = DICTS[currentLang] ?? DICTS[FALLBACK];
  let s = dict?.[key];
  if (s === undefined) s = DICTS[FALLBACK]?.[key];
  if (s === undefined) return key;
  if (params) {
    s = s.replace(/\{(\w+)\}/g, (_, k: string) =>
      k in params ? String(params[k]) : `{${k}}`,
    );
  }
  return s;
}

// Хук для компонентов: подписывает на смену языка (перерисовка) и отдаёт
// текущий язык. Достаточно вызвать один раз в компоненте, который использует t().
export function useLang(): Lang {
  const [, force] = useReducer((x: number) => x + 1, 0);
  useEffect(() => {
    const fn = () => force();
    listeners.add(fn);
    return () => {
      listeners.delete(fn);
    };
  }, []);
  return currentLang;
}
