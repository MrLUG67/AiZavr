// src/widgets/host/WidgetHost.tsx
// TEA-движок одного виджета (D-070, D-072). Цикл: state -> view -> update.
// facts и cap приходят пропсами (их собирает контейнер/реестр) — хост остаётся
// чистым раннером. cap протягивается ТОЛЬКО в update; во view капабилити нет.
//
// Развилка sync/async (обещано при проектировании controls):
//   update вернул State  -> применяем СИНХРОННО, сразу (правка preview: без лагов)
//   update вернул Promise -> сериализуем через цепочку (вызовы ядра по порядку)
// Обе ветви на УСПЕХЕ чистят error (симметрия): липкая ошибка update снимается
// первым же удачным обновлением — хоть sync, хоть async.
//
// Падение плагина не роняет панель (D-070/D-073): view и update в try/catch,
// при ошибке виджет показывает плашку, остальные виджеты живут.
//
// Применимость и неактивность (D-082/D-083): два рубежа перед/вокруг view —
// ГРУБЫЙ (хост по manifest.supportedModels) и ТОНКИЙ (плагин вернул inactive).
// Серую плашку обоих рубежей рисует ХОСТ единообразно (host-native, не контрол).

import { useEffect, useMemo, useRef, useState } from 'react';
import { ControlTree, type Dispatch } from './controls';
import { registerWidgetDispatch, unregisterWidgetDispatch } from './widgetDispatch';
import { makeCapabilities, type CapabilityDeps } from './capabilities';
import type {
  WidgetDef,
  WidgetFacts,
  WidgetMsg,
  ViewResult,
} from './types';

function isPromise<T>(x: T | Promise<T>): x is Promise<T> {
  return typeof (x as { then?: unknown })?.then === 'function';
}

// Применимость плагина к активной модели (D-082). ГРУБЫЙ рубеж: хост сверяет
// facts.model.id с manifest.supportedModels. Отсутствует или '*' => любая модель.
// Иначе совпадение по списку: точное равенство ЛИБО префикс-паттерн с хвостовой
// звёздочкой ('openai/*' матчит 'openai/gpt-4o'). Минимум под реальную нужду
// (D-074): шире не выдумываем, пока нет плагина, которому этого мало.
function modelApplicable(
  supported: string[] | '*' | undefined,
  modelId: string,
): boolean {
  if (supported === undefined || supported === '*') return true;
  return supported.some((pat) => {
    if (pat === '*') return true;
    if (pat.endsWith('*')) return modelId.startsWith(pat.slice(0, -1));
    return pat === modelId;
  });
}

export function WidgetHost<State>(props: {
  def: WidgetDef<State>;
  facts: WidgetFacts;
  capabilityDeps: CapabilityDeps;
}): React.ReactElement {
  const { def, facts, capabilityDeps } = props;

  // Капабилити привязаны к ЭТОМУ виджету (D-095): pluginId = manifest.id берёт
  // ХОСТ, не плагин — namespacing конфига/секретов форсится ядром. Раньше cap
  // был один на всю панель; теперь свой на виджет.
  const cap = useMemo(
    () => makeCapabilities(capabilityDeps, def.manifest.id),
    [capabilityDeps, def.manifest.id],
  );

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
      // СИНХРОННО: чистая мутация state (напр. правка preview) — сразу, без очереди.
      // На успехе чистим error СИММЕТРИЧНО async-ветке: иначе плашка сбоя от
      // прошлого упавшего async-обновления залипнет после удачного sync-update.
      stateRef.current = result;
      setState(result);
      setError(null);
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
    registerWidgetDispatch(def.manifest.id, dispatch);
    return () => unregisterWidgetDispatch(def.manifest.id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ---- render ----

  // (1) Сбой плагина (D-070/D-073) — приоритетнее всего: упал => плашка сбоя,
  // независимо от применимости. role=alert (это ОШИБКА, не штатное состояние).
  if (error) {
    return (
      <div className="widget-error" role="alert">
        Виджет «{def.manifest.title}» дал сбой.
      </div>
    );
  }

  // (2) ГРУБЫЙ рубеж применимости (D-082/D-083): не та модель -> серая плашка,
  // view НЕ зовётся. Причину пишет ХОСТ (плагин не запускался).
  // Caveat MVP: рубеж глушит только ОТРИСОВКУ; initialState/@@mount/update выше
  // всё равно отработали. Для context-meter (supportedModels '*') безвредно;
  // model-specific плагинов в MVP нет (D-080 мир B — после MVP). Глушить bootstrap
  // негодной модели — уточнение под реальный такой плагин, не сейчас (D-074).
  if (!modelApplicable(def.manifest.supportedModels, facts.model.id)) {
    return (
      <div className="widget-inactive" aria-disabled="true">
        Неприменимо к модели {facts.model.id}
      </div>
    );
  }

  // view -> ViewResult (D-083): состав (ControlNode) ЛИБО {inactive, reason}.
  let result: ViewResult;
  try {
    result = def.view(state, facts);
  } catch (e) {
    console.error(`[widget ${def.manifest.id}] view threw`, e);
    return (
      <div className="widget-error" role="alert">
        Виджет «{def.manifest.title}» дал сбой при отрисовке.
      </div>
    );
  }

  // (3) ТОНКИЙ рубеж (D-083): модель подходит, но плагину нечего показать
  // (нет беседы, негодный факт). Серую плашку с reason рисует ХОСТ единообразно.
  // Сужение объединения: 'inactive' есть только у InactiveResult, не у ControlNode.
  if ('inactive' in result) {
    return (
      <div className="widget-inactive" aria-disabled="true">
        {result.reason}
      </div>
    );
  }

  // result сужен до ControlNode — отдаём рендереру каталога.
  return <ControlTree root={result} dispatch={dispatch} />;
}