-- AiZavr initial schema
-- Migration 001

-- Tree nodes: core storage unit
CREATE TABLE IF NOT EXISTS nodes (
    id              TEXT PRIMARY KEY,           -- UUID v4
    parent_id       TEXT REFERENCES nodes(id),  -- NULL for root
    dialog_id       TEXT NOT NULL REFERENCES dialogs(id) ON DELETE CASCADE,
    node_type       TEXT NOT NULL,              -- user_message | assistant_message | artifact | compressed_summary | system | context_migration
    content         TEXT NOT NULL DEFAULT '',   -- message text or artifact reference
    active_child_id TEXT REFERENCES nodes(id),  -- active branch pointer

    -- Frequently queried fields (not in JSON)
    model_id        TEXT,                       -- which model generated this node
    model_role      TEXT,                       -- main_dialog | compression_L1 | compression_L2 | compression_L3
    tokens_count    INTEGER NOT NULL DEFAULT 0,
    is_pinned       INTEGER NOT NULL DEFAULT 0, -- boolean: protected from compression
    is_protected    INTEGER NOT NULL DEFAULT 0, -- boolean: contains code/numbers/decisions
    compression_level TEXT,                     -- L1 | L2 | L3 (NULL if not a summary)

    -- Rarely queried details
    extra           TEXT,                       -- JSON: artifact params, compression stats, migration info

    created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

-- Dialogs: conversation roots
CREATE TABLE IF NOT EXISTS dialogs (
    id              TEXT PRIMARY KEY,           -- UUID v4
    notebook_id     TEXT REFERENCES notebooks(id) ON DELETE SET NULL,
    root_node_id    TEXT,                       -- set after first node created
    active_leaf_id  TEXT,                       -- current cursor position in tree
    title           TEXT NOT NULL DEFAULT '',
    use_knowledge_cards INTEGER NOT NULL DEFAULT 1, -- boolean
    created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    updated_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

-- Notebooks: containers for dialogs
CREATE TABLE IF NOT EXISTS notebooks (
    id                      TEXT PRIMARY KEY,   -- UUID v4
    parent_notebook_id      TEXT REFERENCES notebooks(id) ON DELETE SET NULL,
    name                    TEXT NOT NULL,
    knowledge_card_id       TEXT,               -- set after card created
    system_prompt           TEXT,               -- optional shared prompt
    default_model_overrides TEXT,               -- JSON: role -> model_id mapping
    created_at              TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

-- Knowledge cards: structured facts per notebook
CREATE TABLE IF NOT EXISTS knowledge_cards (
    id          TEXT PRIMARY KEY,               -- UUID v4
    notebook_id TEXT NOT NULL REFERENCES notebooks(id) ON DELETE CASCADE,
    sections    TEXT NOT NULL DEFAULT '[]',     -- JSON: [{title, facts: [{text, stability, added_at, source_dialog_id}]}]
    tokens_count_at_last_update INTEGER NOT NULL DEFAULT 0, -- for freshness indicator (D-038)
    updated_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_nodes_dialog_id   ON nodes(dialog_id);
CREATE INDEX IF NOT EXISTS idx_nodes_parent_id   ON nodes(parent_id);
CREATE INDEX IF NOT EXISTS idx_dialogs_notebook  ON dialogs(notebook_id);
CREATE INDEX IF NOT EXISTS idx_dialogs_updated   ON dialogs(updated_at);
CREATE INDEX IF NOT EXISTS idx_notebooks_parent  ON notebooks(parent_notebook_id);