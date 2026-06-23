// Тонкий слой локализации фронта (i18n). Решение сессии 11:
//   - перевод живёт ТОЛЬКО на фронте, ядро языка не знает;
//   - строки вынесены в JSON-локали (ключи = алиасы), грузятся при старте;
//   - смена языка — без перезапуска: меняем язык -> уведомляем подписчиков ->
//     React-компоненты, дёрнувшие useLang(), перерисовываются.
// Множественное число НЕ разруливаем правилами: где в русском «ветки», там в
// английском просто branch(es) — дословная подстановка, по договорённости.
// Плагины (widgets/*) сюда НЕ входят — у них будут свои файлы локалей позже.

import { useEffect, useReducer } from "react";
import ru from "./locales/ru.json";
import en from "./locales/en.json";

export type Lang = "ru" | "en";

type Dict = Record<string, string>;

// Реестр локалей. Добавить язык = положить JSON и вписать сюда одну строку.
const DICTS: Record<Lang, Dict> = { ru, en };

// Подписи языков для меню (на родном языке, не переводятся).
export const LANG_NAMES: Record<Lang, string> = {
  ru: "Русский",
  en: "English",
};

const LS_LANG = "aizavr.lang";
const FALLBACK: Lang = "ru";

function detectLang(): Lang {
  try {
    const saved = localStorage.getItem(LS_LANG);
    if (saved === "ru" || saved === "en") return saved;
  } catch {}
  // Системная локаль как дефолт: ru -> русский, иначе английский.
  const sys = (navigator.language || "").toLowerCase();
  return sys.startsWith("ru") ? "ru" : "en";
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

export function setLang(lang: Lang): void {
  if (lang === currentLang) return;
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
// Порядок поиска: текущий язык -> русский (fallback) -> сам ключ (видно в UI,
// что забыли перевести).
export function t(key: string, params?: Record<string, string | number>): string {
  const dict = DICTS[currentLang] ?? DICTS[FALLBACK];
  let s = dict[key];
  if (s === undefined) s = DICTS[FALLBACK][key];
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
