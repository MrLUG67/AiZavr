// Верхняя строка меню приложения. Пока минимум: «Файл» → «Выход».
// Остальные пункты добавим позже. Закрытие окна = выход (одно окно).

import { useEffect, useRef, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { t, useLang, setLang, LANG_NAMES, type Lang } from "../i18n";

type Theme = "light" | "dark";

const LANGS: Lang[] = ["ru", "en"];

function readTheme(): Theme {
  const v = document.documentElement.getAttribute("data-theme");
  return v === "dark" ? "dark" : "light";
}

function applyTheme(theme: Theme) {
  document.documentElement.setAttribute("data-theme", theme);
  try { localStorage.setItem("aizavr.theme", theme); } catch {}
}

export function MenuBar(): React.ReactElement {
  // Какое верхнее меню сейчас раскрыто (по id). null — всё закрыто.
  const [openMenu, setOpenMenu] = useState<string | null>(null);
  const [theme, setTheme] = useState<Theme>(() => readTheme());
  const lang = useLang();
  const barRef = useRef<HTMLDivElement>(null);

  function selectTheme(next: Theme) {
    applyTheme(next);
    setTheme(next);
    setOpenMenu(null);
  }

  function selectLang(next: Lang) {
    setLang(next);
    setOpenMenu(null);
  }

  // Клик вне строки меню — закрыть раскрытый пункт.
  useEffect(() => {
    if (!openMenu) return;
    function onDocClick(e: MouseEvent) {
      if (barRef.current && !barRef.current.contains(e.target as Node)) {
        setOpenMenu(null);
      }
    }
    function onEsc(e: KeyboardEvent) {
      if (e.key === "Escape") setOpenMenu(null);
    }
    document.addEventListener("mousedown", onDocClick);
    document.addEventListener("keydown", onEsc);
    return () => {
      document.removeEventListener("mousedown", onDocClick);
      document.removeEventListener("keydown", onEsc);
    };
  }, [openMenu]);

  async function exitApp() {
    setOpenMenu(null);
    try {
      await getCurrentWindow().close();
    } catch (e) {
      console.error("window close failed:", e);
    }
  }

  return (
    <div className="menu-bar" ref={barRef}>
      <div className="menu-bar-item-wrap">
        <button
          className={`menu-bar-item ${openMenu === "file" ? "is-open" : ""}`}
          onClick={() => setOpenMenu(m => (m === "file" ? null : "file"))}
          onMouseEnter={() => { if (openMenu) setOpenMenu("file"); }}
        >
          {t("menu.file")}
        </button>
        {openMenu === "file" && (
          <div className="menu-dropdown">
            <button className="menu-dropdown-item" onClick={exitApp}>
              {t("menu.exit")}
            </button>
          </div>
        )}
      </div>

      <div className="menu-bar-item-wrap">
        <button
          className={`menu-bar-item ${openMenu === "settings" ? "is-open" : ""}`}
          onClick={() => setOpenMenu(m => (m === "settings" ? null : "settings"))}
          onMouseEnter={() => { if (openMenu) setOpenMenu("settings"); }}
        >
          {t("menu.settings")}
        </button>
        {openMenu === "settings" && (
          <div className="menu-dropdown">
            <button className="menu-dropdown-item" onClick={() => selectTheme("dark")}>
              <span className="menu-dropdown-check">{theme === "dark" ? "✓" : ""}</span>
              {t("menu.darkTheme")}
            </button>
            <button className="menu-dropdown-item" onClick={() => selectTheme("light")}>
              <span className="menu-dropdown-check">{theme === "light" ? "✓" : ""}</span>
              {t("menu.lightTheme")}
            </button>
            <div className="menu-dropdown-sep" />
            <div className="menu-dropdown-label">{t("menu.language")}</div>
            {LANGS.map((code) => (
              <button
                key={code}
                className="menu-dropdown-item"
                onClick={() => selectLang(code)}
              >
                <span className="menu-dropdown-check">{lang === code ? "✓" : ""}</span>
                {LANG_NAMES[code]}
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
