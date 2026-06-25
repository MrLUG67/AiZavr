-- Migration 007: tags for dialogs
-- Tags are stored normalized (lowercase, without leading '#').

CREATE TABLE IF NOT EXISTS dialog_tags (
    dialog_id   TEXT NOT NULL REFERENCES dialogs(id) ON DELETE CASCADE,
    tag         TEXT NOT NULL,
    created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    PRIMARY KEY (dialog_id, tag)
);

CREATE INDEX IF NOT EXISTS idx_dialog_tags_tag ON dialog_tags(tag);
