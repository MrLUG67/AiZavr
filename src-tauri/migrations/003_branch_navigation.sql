-- AiZavr branch children counter
-- Migration 003

-- children_count: денормализованный счётчик прямых детей узла.
-- Инкрементируется в create_node при добавлении каждого нового дочернего узла.
-- Используется в UI: если children_count > 1 у A-узла — показываем иконку дерева.
ALTER TABLE nodes ADD COLUMN children_count INTEGER NOT NULL DEFAULT 0;
