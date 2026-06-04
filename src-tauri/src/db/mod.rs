use sqlx::{sqlite::SqlitePoolOptions, SqlitePool, Row};
use std::fs;

// ---------------------------------------------------------------------------
// Инициализация
// ---------------------------------------------------------------------------

pub async fn init_db(app_data_dir: &str) -> Result<SqlitePool, sqlx::Error> {
    fs::create_dir_all(app_data_dir).ok();

    let db_path = format!("{}/aizavr.db", app_data_dir);
    let db_url = format!("sqlite://{}?mode=rwc", db_path);

    let pool = SqlitePoolOptions::new()
        .max_connections(5)
        .connect(&db_url)
        .await?;

    sqlx::migrate!("./migrations")
        .run(&pool)
        .await
        .expect("failed to run migrations");

    Ok(pool)
}

// ---------------------------------------------------------------------------
// Структуры данных
// ---------------------------------------------------------------------------

/// Диалог — корень беседы.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct DbDialog {
    pub id: String,
    pub notebook_id: Option<String>,
    pub root_node_id: Option<String>,
    pub active_leaf_id: Option<String>,
    pub title: String,
    pub use_knowledge_cards: bool,
    pub created_at: String,
    pub updated_at: String,
}

/// Узел дерева — минимальная единица хранения.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct DbNode {
    pub id: String,
    pub parent_id: Option<String>,
    pub dialog_id: String,
    pub node_type: String,      // user_message | assistant_message | system | ...
    pub content: String,
    pub active_child_id: Option<String>,
    pub model_id: Option<String>,
    pub model_role: Option<String>,
    pub tokens_count: i64,
    pub is_pinned: bool,
    pub is_protected: bool,
    pub compression_level: Option<String>,
    pub extra: Option<String>,  // JSON
    pub created_at: String,
}

// ---------------------------------------------------------------------------
// Диалоги
// ---------------------------------------------------------------------------

/// Создать новый диалог. Возвращает созданный DbDialog.
pub async fn create_dialog(
    pool: &SqlitePool,
    id: &str,
    title: &str,
    notebook_id: Option<&str>,
) -> Result<DbDialog, sqlx::Error> {
    sqlx::query(
        "INSERT INTO dialogs (id, title, notebook_id) VALUES (?, ?, ?)"
    )
    .bind(id)
    .bind(title)
    .bind(notebook_id)
    .execute(pool)
    .await?;

    get_dialog(pool, id).await?.ok_or(sqlx::Error::RowNotFound)
}

/// Получить диалог по id.
pub async fn get_dialog(
    pool: &SqlitePool,
    id: &str,
) -> Result<Option<DbDialog>, sqlx::Error> {
    let row = sqlx::query(
        "SELECT id, notebook_id, root_node_id, active_leaf_id, title,
                use_knowledge_cards, created_at, updated_at
         FROM dialogs WHERE id = ?"
    )
    .bind(id)
    .fetch_optional(pool)
    .await?;

    Ok(row.map(|r| DbDialog {
        id: r.get("id"),
        notebook_id: r.get("notebook_id"),
        root_node_id: r.get("root_node_id"),
        active_leaf_id: r.get("active_leaf_id"),
        title: r.get("title"),
        use_knowledge_cards: r.get::<i64, _>("use_knowledge_cards") != 0,
        created_at: r.get("created_at"),
        updated_at: r.get("updated_at"),
    }))
}

/// Список всех диалогов, отсортированных по дате обновления (новые первые).
pub async fn list_dialogs(
    pool: &SqlitePool,
) -> Result<Vec<DbDialog>, sqlx::Error> {
    let rows = sqlx::query(
        "SELECT id, notebook_id, root_node_id, active_leaf_id, title,
                use_knowledge_cards, created_at, updated_at
         FROM dialogs ORDER BY updated_at DESC"
    )
    .fetch_all(pool)
    .await?;

    Ok(rows.into_iter().map(|r| DbDialog {
        id: r.get("id"),
        notebook_id: r.get("notebook_id"),
        root_node_id: r.get("root_node_id"),
        active_leaf_id: r.get("active_leaf_id"),
        title: r.get("title"),
        use_knowledge_cards: r.get::<i64, _>("use_knowledge_cards") != 0,
        created_at: r.get("created_at"),
        updated_at: r.get("updated_at"),
    }).collect())
}

/// Обновить заголовок диалога.
pub async fn update_dialog_title(
    pool: &SqlitePool,
    dialog_id: &str,
    title: &str,
) -> Result<(), sqlx::Error> {
    sqlx::query(
        "UPDATE dialogs SET title = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
         WHERE id = ?"
    )
    .bind(title)
    .bind(dialog_id)
    .execute(pool)
    .await?;
    Ok(())
}

/// Обновить указатель на активный лист (позиция курсора в дереве).
pub async fn update_dialog_leaf(
    pool: &SqlitePool,
    dialog_id: &str,
    leaf_id: &str,
) -> Result<(), sqlx::Error> {
    sqlx::query(
        "UPDATE dialogs
         SET active_leaf_id = ?,
             updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
         WHERE id = ?"
    )
    .bind(leaf_id)
    .bind(dialog_id)
    .execute(pool)
    .await?;
    Ok(())
}

// ---------------------------------------------------------------------------
// Узлы
// ---------------------------------------------------------------------------

/// Создать новый узел. Автоматически:
/// - прописывает себя как active_child у родителя
/// - если это первый узел диалога — устанавливает root_node_id
/// - обновляет active_leaf_id диалога
pub async fn create_node(
    pool: &SqlitePool,
    id: &str,
    dialog_id: &str,
    parent_id: Option<&str>,
    node_type: &str,
    content: &str,
    model_id: Option<&str>,
    model_role: Option<&str>,
    tokens_count: i64,
) -> Result<DbNode, sqlx::Error> {
    sqlx::query(
        "INSERT INTO nodes
            (id, dialog_id, parent_id, node_type, content, model_id, model_role, tokens_count)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
    )
    .bind(id)
    .bind(dialog_id)
    .bind(parent_id)
    .bind(node_type)
    .bind(content)
    .bind(model_id)
    .bind(model_role)
    .bind(tokens_count)
    .execute(pool)
    .await?;

    // Если есть родитель — прописываем себя как его active_child
    if let Some(pid) = parent_id {
        set_active_child(pool, pid, id).await?;
    }

    // Если это первый узел диалога — устанавливаем root_node_id
    let dialog = get_dialog(pool, dialog_id).await?;
    if let Some(d) = dialog {
        if d.root_node_id.is_none() {
            sqlx::query(
                "UPDATE dialogs SET root_node_id = ? WHERE id = ?"
            )
            .bind(id)
            .bind(dialog_id)
            .execute(pool)
            .await?;
        }
    }

    // Обновляем курсор диалога на этот узел
    update_dialog_leaf(pool, dialog_id, id).await?;

    get_node(pool, id).await?.ok_or(sqlx::Error::RowNotFound)
}

/// Получить узел по id.
pub async fn get_node(
    pool: &SqlitePool,
    id: &str,
) -> Result<Option<DbNode>, sqlx::Error> {
    let row = sqlx::query(
        "SELECT id, parent_id, dialog_id, node_type, content, active_child_id,
                model_id, model_role, tokens_count, is_pinned, is_protected,
                compression_level, extra, created_at
         FROM nodes WHERE id = ?"
    )
    .bind(id)
    .fetch_optional(pool)
    .await?;

    Ok(row.map(node_from_row))
}

/// Получить прямых детей узла (все ветки от данной точки).
pub async fn get_children(
    pool: &SqlitePool,
    parent_id: &str,
) -> Result<Vec<DbNode>, sqlx::Error> {
    let rows = sqlx::query(
        "SELECT id, parent_id, dialog_id, node_type, content, active_child_id,
                model_id, model_role, tokens_count, is_pinned, is_protected,
                compression_level, extra, created_at
         FROM nodes WHERE parent_id = ? ORDER BY created_at ASC"
    )
    .bind(parent_id)
    .fetch_all(pool)
    .await?;

    Ok(rows.into_iter().map(node_from_row).collect())
}

/// Установить active_child у узла — определяет, какая ветка «активна».
pub async fn set_active_child(
    pool: &SqlitePool,
    node_id: &str,
    child_id: &str,
) -> Result<(), sqlx::Error> {
    sqlx::query(
        "UPDATE nodes SET active_child_id = ? WHERE id = ?"
    )
    .bind(child_id)
    .bind(node_id)
    .execute(pool)
    .await?;
    Ok(())
}

/// Получить активную ветку диалога — линейный путь от корня до активного листа.
/// Именно этот список уходит в LLM при следующем запросе.
pub async fn get_branch(
    pool: &SqlitePool,
    dialog_id: &str,
) -> Result<Vec<DbNode>, sqlx::Error> {
    // Получаем корень и активный лист
    let dialog = get_dialog(pool, dialog_id)
        .await?
        .ok_or(sqlx::Error::RowNotFound)?;

    let leaf_id = match dialog.active_leaf_id {
        Some(id) => id,
        None => return Ok(vec![]),
    };

    // Идём от листа вверх по parent_id, собираем путь
    let mut branch: Vec<DbNode> = Vec::new();
    let mut current_id = leaf_id;

    loop {
        let node = get_node(pool, &current_id)
            .await?
            .ok_or(sqlx::Error::RowNotFound)?;

        let parent_id = node.parent_id.clone();
        branch.push(node);

        match parent_id {
            Some(pid) => current_id = pid,
            None => break, // дошли до корня
        }
    }

    // Разворачиваем: теперь порядок от корня к листу
    branch.reverse();
    Ok(branch)
}

// ---------------------------------------------------------------------------
// Вспомогательные функции
// ---------------------------------------------------------------------------

fn node_from_row(r: sqlx::sqlite::SqliteRow) -> DbNode {
    DbNode {
        id: r.get("id"),
        parent_id: r.get("parent_id"),
        dialog_id: r.get("dialog_id"),
        node_type: r.get("node_type"),
        content: r.get("content"),
        active_child_id: r.get("active_child_id"),
        model_id: r.get("model_id"),
        model_role: r.get("model_role"),
        tokens_count: r.get("tokens_count"),
        is_pinned: r.get::<i64, _>("is_pinned") != 0,
        is_protected: r.get::<i64, _>("is_protected") != 0,
        compression_level: r.get("compression_level"),
        extra: r.get("extra"),
        created_at: r.get("created_at"),
    }
}
