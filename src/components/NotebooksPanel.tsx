// Левая панель «Блокноты»: show-hide, регулируемая ширина, своя прокрутка.
// Каждый диалог будет жить в блокноте. Структуру наполним позже — пока это
// каркас панели с пустым телом.

import { useEffect, useState } from "react";

const LS_OPEN = "aizavr.notebooks.open";
const LS_WIDTH = "aizavr.notebooks.width";

const WIDTH_MIN = 180;
const WIDTH_MAX = 480;
const WIDTH_DEFAULT = 240;

function readBool(key: string, fallback: boolean): boolean {
  try {
    const v = localStorage.getItem(key);
    return v === null ? fallback : v === "1";
  } catch {
    return fallback;
  }
}

function readNum(key: string, fallback: number): number {
  try {
    const v = localStorage.getItem(key);
    const n = v === null ? NaN : Number(v);
    return Number.isFinite(n) ? n : fallback;
  } catch {
    return fallback;
  }
}

export function NotebooksPanel(): React.ReactElement {
  const [open, setOpen] = useState(() => readBool(LS_OPEN, true));
  const [width, setWidth] = useState(() => readNum(LS_WIDTH, WIDTH_DEFAULT));

  useEffect(() => { try { localStorage.setItem(LS_OPEN, open ? "1" : "0"); } catch {} }, [open]);
  useEffect(() => { try { localStorage.setItem(LS_WIDTH, String(width)); } catch {} }, [width]);

  // Свёрнуто: узкий рельс с кнопкой развернуть.
  if (!open) {
    return (
      <div className="notebooks-rail">
        <button
          className="notebooks-rail-expand"
          title="Показать блокноты"
          onClick={() => setOpen(true)}
        >
          ▶
        </button>
        <span className="notebooks-rail-label">Блокноты</span>
      </div>
    );
  }

  // Перетаскивание ширины: панель слева — тянем правую кромку.
  const onResizeStart = (e: React.PointerEvent) => {
    e.preventDefault();
    const startX = e.clientX;
    const startW = width;
    const onMove = (ev: PointerEvent) => {
      const next = Math.min(WIDTH_MAX, Math.max(WIDTH_MIN, startW + (ev.clientX - startX)));
      setWidth(next);
    };
    const onUp = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  };

  return (
    <aside className="notebooks-panel" style={{ width }}>
      <header className="notebooks-head">
        <span className="notebooks-title">Блокноты</span>
        <button
          className="notebooks-collapse"
          title="Скрыть блокноты"
          onClick={() => setOpen(false)}
        >
          ◀
        </button>
      </header>

      <div className="notebooks-body">
        <p className="notebooks-empty">Здесь будут блокноты с диалогами.</p>
      </div>

      <div className="notebooks-resizer" onPointerDown={onResizeStart} />
    </aside>
  );
}
