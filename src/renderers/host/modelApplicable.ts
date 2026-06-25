// src/renderers/host/modelApplicable.ts
// Применимость рендерера/парсера к активной модели — та же логика, что у виджетов
// (см. WidgetHost.modelApplicable, D-082). Вынесена сюда, чтобы подсистема
// рендеринга не зависела от виджет-хоста. Отсутствует или '*' => любая модель;
// иначе совпадение по списку: точное равенство ЛИБО префикс с хвостовой '*'
// ('openai/*' матчит 'openai/gpt-4o').

export function modelApplicable(
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
