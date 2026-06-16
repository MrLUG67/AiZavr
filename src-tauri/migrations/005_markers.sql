-- migrations/005_markers.sql
-- Маркеры (D-058): персистентные именованные точки на A-узлах.
-- Первый потребитель — сжатие (выбор границ диапазона, D-057/D-059).

CREATE TABLE markers (
    id         TEXT PRIMARY KEY NOT NULL,
    node_id    TEXT NOT NULL,
    label      TEXT NOT NULL,
    comment    TEXT,
    created_at TEXT NOT NULL
);

-- Для двух задач: выборка маркеров диалога (через node→dialog)
-- и проверка целостности D-067 (поиск маркера по node_id).
CREATE INDEX idx_markers_node ON markers(node_id);