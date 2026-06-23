// Верхняя строка меню приложения. Пока минимум: «Файл» → «Выход».
// Остальные пункты добавим позже. Закрытие окна = выход (одно окно).

import { useEffect, useRef, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";

type Theme = "light" | "dark";

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
  const barRef = useRef<HTMLDivElement>(null);

  function selectTheme(next: Theme) {
    applyTheme(next);
    setTheme(next);
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
          Файл
        </button>
        {openMenu === "file" && (
          <div className="menu-dropdown">
            <button className="menu-dropdown-item" onClick={exitApp}>
              Выход
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
          Настройки
        </button>
        {openMenu === "settings" && (
          <div className="menu-dropdown">
            <button className="menu-dropdown-item" onClick={() => selectTheme("dark")}>
              <span className="menu-dropdown-check">{theme === "dark" ? "✓" : ""}</span>
              Тёмная тема
            </button>
            <button className="menu-dropdown-item" onClick={() => selectTheme("light")}>
              <span className="menu-dropdown-check">{theme === "light" ? "✓" : ""}</span>
              Светлая тема
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
