// src/dialog/buildLlmMessages.ts
// Сборка цепочки для LLM из линейной ветки узлов. Чистая функция без побочных
// эффектов — вынесена из App.tsx (шаг 1). Логика срезки заглушек и склейки
// ролей сохранена дословно.

import type { DbNode, LlmMessage } from "./types";

// Превращает линейную ветку узлов в сообщения для LLM.
// Правило: unanswered_placeholder — служебная заглушка-ответ.
//   - заглушка В СЕРЕДИНЕ ветки = холостой Q из прошлого сбоя: срезаем
//     и её, и Q над ней (для модели этой пары не было).
//   - заглушка НА КОНЦЕ ветки = текущий ожидающий запрос: её Q обязан уйти
//     в LLM (на него и ждём ответ), пропускаем только саму пустую заглушку.
export function buildLlmMessages(nodes: DbNode[]): LlmMessage[] {
  const out: LlmMessage[] = [];
  const lastIdx = nodes.length - 1;

  nodes.forEach((n, idx) => {
    if (n.node_type === "unanswered_placeholder") {
      if (idx === lastIdx) {
        // Текущий запрос: Q уже добавлен предыдущей итерацией, его оставляем.
        // Саму заглушку (пустую) в модель не шлём.
        return;
      }
      // Холостой Q из прошлого: срезаем заглушку и Q над ней.
      if (out.length > 0 && out[out.length - 1].role === "user") {
        out.pop();
      }
      return;
    }
    // Узел-резюме сжатия (S): уходит в модель как вводный контекст вместо
    // свёрнутого диапазона (D-060). Структурно сидит в Q-слоте -> роль user.
    if (n.node_type === "compressed_summary") {
      out.push({
        role: "user",
        content: `[Сжатое резюме предыдущего участка беседы]\n${n.content}`,
      });
      return;
    }
    // Заглушка под S — служебная, в модель НЕ идёт (D-061).
    if (n.node_type === "compression_placeholder") {
      return;
    }
    if (n.node_type === "user_message") {
      out.push({ role: "user", content: n.content });
    } else if (n.node_type === "assistant_message") {
      out.push({ role: "assistant", content: n.content });
    }
    // прочие служебные типы — в LLM не идут
  });

  // Склейка соседних сообщений одной роли: после среза заглушек и вставки S
  // могут оказаться два user подряд (S + новый вопрос). Сливаем, чтобы не
  // ломать чередование ролей у провайдера.
  const merged: LlmMessage[] = [];
  for (const m of out) {
    const last = merged[merged.length - 1];
    if (last && last.role === m.role) {
      last.content += `\n\n${m.content}`;
    } else {
      merged.push({ ...m });
    }
  }

  return merged;
}
