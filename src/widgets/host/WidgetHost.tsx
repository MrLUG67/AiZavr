// src/widgets/host/WidgetHost.tsx
// TEA-движок одного виджета (D-070, D-072). Цикл: state -> view -> update.
// facts и cap приходят пропсами (их собирает контейнер/реестр) — хост остаётся
// чистым раннером. cap протягивается ТОЛЬКО в update; во view капабилити нет.
//
// Развилка sync/async (обещано при проектировании controls):
//   update вернул State  -> применяем СИНХРОННО, сразу (правка preview: без лагов)
//   update вернул Promise -> сериализуем через цепочку (вызовы ядра по порядку)
//
// Падение плагина не роняет панель (D-070/D-073): view и update в try/catch,
// при ошибке виджет показывает плашку, остальные виджеты живут.

import { useEffect, useRef, useState } from 'react';
import { ControlTree, type Dispatch } from './controls';
import type {
  WidgetDef,
  WidgetFacts,
  WidgetCapabilities,
  WidgetMsg,
} from './types';

function isPromise<T>(x: T | Promise<T>): x is Promise<T> {
  return typeof (x as { then?: unknown })?.then === 'function';
}

export function WidgetHost<State>(props: {
  def: WidgetDef<State>;
  facts: WidgetFacts;
  cap: WidgetCapabilities;
}): React.ReactElement {
  const { def, facts, cap } = props;

  // initialState вызывается ОДИН раз (контракт). Последующие изменения фактов
  // втекают в view(state, facts), не пересоздают state.
  const [state, setState] = useState<State>(() => {
    try {
      return def.initialState(facts);
    } catch (e) {
      // если даже initialState падает — стартуем с маркером ошибки ниже
      console.error(`[widget ${def.manifest.id}] initialState failed`, e);
      return undefined as unknown as State;
    }
  });

  const [error, setError] = useState<string | null>(null);

  // Зеркало state для чтения внутри async без устаревания замыкания.
  const stateRef = useRef<State>(state);
  stateRef.current = state;

  // Цепочка сериализации async-обновлений (вызовы ядра идут по порядку).
  const chainRef = useRef<Promise<void>>(Promise.resolve());

  const dispatch: Dispatch = (msg: WidgetMsg) => {
    let result: State | Promise<State>;
    try {
      result = def.update(msg, stateRef.current, cap);
    } catch (e) {
      console.error(`[widget ${def.manifest.id}] update threw`, e);
      setError(String(e));
      return;
    }

    if (!isPromise(result)) {
      // СИНХРОННО: чистая мутация state (напр. правка preview) — сразу, без очереди
      stateRef.current = result;
      setState(result);
      return;
    }

    // ASYNC: серилизуем, чтобы вызовы ядра не клобберили друг друга по порядку.
    // Граница MVP: async-update захватывает state на момент dispatch. Наши два
    // виджета не совмещают правку preview с async того же виджета, поэтому
    // перекрытия нет. Если появится такой виджет — понадобится reducer-форма.
    chainRef.current = chainRef.current
      .then(() => result)
      .then((next) => {
        stateRef.current = next;
        setState(next);
        setError(null);
      })
      .catch((e) => {
        console.error(`[widget ${def.manifest.id}] async update failed`, e);
        setError(String(e));
      });
  };

  // @@mount — один раз после монтирования. Точка асинхронного bootstrap
  // (compression грузит startable-маркеры). eslint-disable: dispatch стабилен
  // по смыслу, перезапускать эффект на каждый рендер не нужно.
  useEffect(() => {
    dispatch({ type: '@@mount' });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ---- render ----
  if (error) {
    return (
      <div className="widget-error" role="alert">
        Виджет «{def.manifest.title}» дал сбой.
      </div>
    );
  }

  let tree;
  try {
    tree = def.view(state, facts);
  } catch (e) {
    console.error(`[widget ${def.manifest.id}] view threw`, e);
    return (
      <div className="widget-error" role="alert">
        Виджет «{def.manifest.title}» дал сбой при отрисовке.
      </div>
    );
  }

  return <ControlTree root={tree} dispatch={dispatch} />;
}