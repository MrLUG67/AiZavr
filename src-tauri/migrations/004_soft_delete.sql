-- Migration 004: soft deletion for branches
-- Adds is_deleted flag to nodes. Physical deletion is a separate explicit operation (Q-028).

ALTER TABLE nodes ADD COLUMN is_deleted INTEGER NOT NULL DEFAULT 0;

-- Composite index: parent_id + is_deleted покрывает основной запрос get_children
-- (выборка видимых детей конкретного родителя)
CREATE INDEX IF NOT EXISTS idx_nodes_parent_deleted 
    ON nodes(parent_id, is_deleted);