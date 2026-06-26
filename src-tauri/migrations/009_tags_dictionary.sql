-- Migration 009: tag dictionary + dialog_tags keyed by tag_id
--
-- Раньше (007) теги были свободными строками в dialog_tags(dialog_id, tag) —
-- по сути «динамический сбор из бесед»: опечатки плодили дубли, тег исчезал
-- вместе с последней беседой. Теперь теги — отдельный СПРАВОЧНИК `tags`,
-- а связка беседа↔тег ссылается на tags.id. Тег живёт независимо от бесед.
--
-- name        — нормализованный ключ (lowercase, без '#', trim) для дедупа/поиска;
-- display_name — как ввёл человек/LLM (для показа, исходный регистр).

-- 1. Справочник тегов.
CREATE TABLE IF NOT EXISTS tags (
    id           TEXT PRIMARY KEY,
    name         TEXT NOT NULL UNIQUE,                 -- normalized: lowercase, no '#', trimmed
    display_name TEXT NOT NULL,                        -- original casing for display
    source       TEXT NOT NULL DEFAULT 'manual',       -- manual | llm
    created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX IF NOT EXISTS idx_tags_name ON tags(name);

-- 2. Перелить существующие теги в справочник. Старые теги уже нормализованы
--    (007 хранил lowercase без '#'), поэтому name = display_name = старое значение.
INSERT OR IGNORE INTO tags (id, name, display_name)
SELECT lower(hex(randomblob(16))), tag, tag
FROM (SELECT DISTINCT tag FROM dialog_tags);

-- 3. Пересоздать связку с tag_id и перелить join'ом по нормализованному имени.
ALTER TABLE dialog_tags RENAME TO dialog_tags_old;

CREATE TABLE dialog_tags (
    dialog_id  TEXT NOT NULL REFERENCES dialogs(id) ON DELETE CASCADE,
    tag_id     TEXT NOT NULL REFERENCES tags(id)    ON DELETE CASCADE,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    PRIMARY KEY (dialog_id, tag_id)
);

INSERT OR IGNORE INTO dialog_tags (dialog_id, tag_id, created_at)
SELECT o.dialog_id, t.id, o.created_at
FROM dialog_tags_old o
JOIN tags t ON t.name = o.tag;

DROP TABLE dialog_tags_old;

CREATE INDEX IF NOT EXISTS idx_dialog_tags_tag_id ON dialog_tags(tag_id);
