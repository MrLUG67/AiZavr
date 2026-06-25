// Доставка сообщений виджету извне (напр. после подтверждения превью в центре).
import type { WidgetMsg } from './types';

const dispatchers = new Map<string, (msg: WidgetMsg) => void>();

export function registerWidgetDispatch(
  widgetId: string,
  dispatch: (msg: WidgetMsg) => void,
): void {
  dispatchers.set(widgetId, dispatch);
}

export function unregisterWidgetDispatch(widgetId: string): void {
  dispatchers.delete(widgetId);
}

export function dispatchWidgetMsg(widgetId: string, msg: WidgetMsg): void {
  dispatchers.get(widgetId)?.(msg);
}
