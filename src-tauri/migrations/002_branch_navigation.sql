-- AiZavr branch navigation
-- Migration 002

-- branch_name: краткое имя ветки для Q-узлов точек ветвления (D-046)
-- Заполняется автогенерацией через LLM при создании ветки.
-- NULL у обычных узлов и у первого Q-узла диалога (не точка ветвления).
ALTER TABLE nodes ADD COLUMN branch_name TEXT;

-- last_visited_leaf_id: последний активный лист в этой ветке (Q-027)
-- Хранится на Q-узлах точек ветвления. Позволяет Ctrl+Left/Right
-- восстанавливать позицию курсора при переключении между ветками.
-- NULL пока пользователь не побывал в этой ветке хотя бы раз.
ALTER TABLE nodes ADD COLUMN last_visited_leaf_id TEXT REFERENCES nodes(id);