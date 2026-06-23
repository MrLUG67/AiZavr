-- Migration 006: notebooks organization
-- Добавляет вид блокнота (kind) и сидит два служебных блокнота:
--   root  — корневой «Личность» (в него вложены все остальные; беседы прямо
--           в нём создавать нельзя, см. notebooks/mod.rs).
--   trash — служебная «Корзина»: цель для мягкого удаления блокнотов и бесед.
-- Оба имеют фиксированные id, чтобы сидинг был идемпотентным.

-- kind: 'root' | 'trash' | 'normal'. У пользовательских блокнотов — 'normal'.
ALTER TABLE notebooks ADD COLUMN kind TEXT NOT NULL DEFAULT 'normal';

-- Корневой блокнот «Личность» (concept 3.6): самый верхний, parent = NULL.
INSERT OR IGNORE INTO notebooks (id, parent_notebook_id, name, kind)
VALUES ('root', NULL, 'Личность', 'root');

-- Служебная «Корзина» — прямой ребёнок корня. Удалённые блокноты/беседы
-- переподчиняются сюда (мягко, обратимо).
INSERT OR IGNORE INTO notebooks (id, parent_notebook_id, name, kind)
VALUES ('trash', 'root', 'Корзина', 'trash');

-- Частый запрос панели: дети блокнота с фильтром по виду (ветвление корня и т.п.).
CREATE INDEX IF NOT EXISTS idx_notebooks_parent_kind
    ON notebooks(parent_notebook_id, kind);
