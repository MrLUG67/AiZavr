// src/widgets/host/WidgetPanel.tsx
// Контейнер виджет-панели (D-070). Ядро владеет хромом, раскладкой, персистом;
// плагины поставляют только содержимое (через WidgetHost). Связь с App — пропсы
// (факты + onFocus + getActiveDialogId). Панель про конкретные виджеты не знает —
// берёт listWidgets() из реестра.
//
// Состояния (MVP-упрощение D-070): свёрнута <-> развёрнута. "Пин" = запомнить
// развёрнутость между перезапусками (персист в localStorage). Настоящий
// авто-хайд-оверлей и многопозиционный докинг — после MVP; тогда пин получит
// полный смысл (push vs overlay). Сейчас не выдумываем то, чего ещё нет.

import { useEffect, useMemo, useState } from 'react';
import { listWidgets } from './registry';
import { WidgetHost } from './WidgetHost';
import { makeCapabilities, type CapabilityDeps } from './capabilities';
import type { WidgetFacts } from './types';

const LS_OPEN = 'aizavr.panel.open';
const LS_PINNED = 'aizavr.panel.pinned';
const LS_WIDTH = 'aizavr.panel.width';

const WIDTH_MIN = 240;
const WIDTH_MAX = 560;
const WIDTH_DEFAULT = 320;

function readBool(key: string, fallback: boolean): boolean {
  try {
    const v = localStorage.getItem(key);
    return v === null ? fallback : v === '1';
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

export function WidgetPanel(props: {
  facts: WidgetFacts;
  capabilityDeps: CapabilityDeps;
}): React.ReactElement {
  const { facts, capabilityDeps } = props;

  // Пин запоминается всегда; open инициализируется пином (закреплён -> открыта).
  const [pinned, setPinned] = useState(() => readBool(LS_PINNED, false));
  const [open, setOpen] = useState(() => readBool(LS_OPEN, readBool(LS_PINNED, false)));
  const [width, setWidth] = useState(() => readNum(LS_WIDTH, WIDTH_DEFAULT));

  useEffect(() => { try { localStorage.setItem(LS_OPEN, open ? '1' : '0'); } catch {} }, [open]);
  useEffect(() => { try { localStorage.setItem(LS_PINNED, pinned ? '1' : '0'); } catch {} }, [pinned]);
  useEffect(() => { try { localStorage.setItem(LS_WIDTH, String(width)); } catch {} }, [width]);

  // Капабилити собираются один раз на набор зависимостей (не на каждый рендер).
  const cap = useMemo(() => makeCapabilities(capabilityDeps), [capabilityDeps]);

  const widgets = useMemo(() => listWidgets(), []);

  // --- свёрнутое состояние: узкий рельс со стрелкой развернуть + иконки ---
  if (!open) {
    return (
      <div className="widget-rail">
        <button
          className="widget-rail-expand"
          title="Развернуть панель"
          onClick={() => setOpen(true)}
        >
          ◀
        </button>
        {/* иконки виджетов как подсказка, что внутри (как activity bar) */}
        <div className="widget-rail-icons">
          {widgets.map((w) => (
            <span key={w.manifest.id} className="widget-rail-icon" title={w.manifest.title}>
              {/* иконка — имя lucide-строкой; пока текстовый плейсхолдер */}
              {w.manifest.title.slice(0, 1)}
            </span>
          ))}
        </div>
      </div>
    );
  }

  // --- развёрнутое состояние ---
  // Перетаскивание ширины: простой указательный drag по левой кромке.
  const onResizeStart = (e: React.PointerEvent) => {
    e.preventDefault();
    const startX = e.clientX;
    const startW = width;
    const onMove = (ev: PointerEvent) => {
      // панель справа: тянем влево -> шире, значит дельта инвертирована
      const next = Math.min(WIDTH_MAX, Math.max(WIDTH_MIN, startW + (startX - ev.clientX)));
      setWidth(next);
    };
    const onUp = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  };

  return (
    <aside className="widget-panel" style={{ width }}>
      <div className="widget-panel-resizer" onPointerDown={onResizeStart} />

      {/* шапка: шестерёнка/быстрые действия + пин + свернуть */}
      <header className="widget-panel-head">
        <button className="widget-panel-gear" title="Настройки" onClick={() => {/* TODO: настройки панели */}}>
          ⚙
        </button>
        <div className="widget-panel-head-spacer" />
        <button
          className={`widget-panel-pin ${pinned ? 'is-pinned' : ''}`}
          title={pinned ? 'Открепить' : 'Закрепить открытой'}
          onClick={() => setPinned((p) => !p)}
        >
          📌
        </button>
        <button
          className="widget-panel-collapse"
          title="Свернуть панель"
          onClick={() => setOpen(false)}
        >
          ▶
        </button>
      </header>

      {/* тело: виджеты по порядку из реестра, каждый в своей секции */}
      <div className="widget-panel-body">
        {widgets.map((def) => (
          <section key={def.manifest.id} className="widget-section">
            <div className="widget-section-title">{def.manifest.title}</div>
            <div className="widget-section-content">
              <WidgetHost def={def} facts={facts} cap={cap} />
            </div>
          </section>
        ))}
      </div>
    </aside>
  );
}