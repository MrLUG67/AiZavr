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

pub const MAX_DIALOG_TAGS: usize = 7;

/// Тег из справочника (caталог `tags`, миграция 009).
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct Tag {
    pub id: String,
    pub name: String,         // нормализованный ключ (lowercase, без '#')
    pub display_name: String, // исходный регистр для показа
    pub source: String,       // manual | llm
    pub created_at: String,
}

/// Тег + число помеченных им бесед (для панели поиска).
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct TagHit {
    #[serde(flatten)]
    pub tag: Tag,
    pub dialog_count: i64,
}

/// Узел дерева — минимальная единица хранения.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct DbNode {
    pub id: String,
    pub parent_id: Option<String>,
    pub dialog_id: String,
    pub node_type: String,               // user_message | assistant_message | unanswered_placeholder | ...
    pub content: String,
    pub active_child_id: Option<String>,
    pub model_id: Option<String>,
    pub model_role: Option<String>,
    // --- добавлено миграцией 008 ---
    pub plugin_id: Option<String>,       // LLM-плагин, сгенерировавший узел
    pub tokens_count: i64,
    pub is_pinned: bool,
    pub is_protected: bool,
    pub compression_level: Option<String>,
    pub extra: Option<String>,           // JSON
    pub created_at: String,
    // --- добавлено миграцией 002 ---
    pub branch_name: Option<String>,
    pub last_visited_leaf_id: Option<String>,
    // --- добавлено миграцией 003 ---
    pub children_count: i64,             // полный счётчик, включая удалённые
    // --- добавлено миграцией 004 ---
    pub is_deleted: bool,                // D-048: мягкое удаление
}

/// Результат отправки пользовательского сообщения.
/// query_id — созданный Q-узел; placeholder_id — заглушка-ответ под ним,
/// которую затем перезапишет resolve_answer при получении ответа LLM.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct SendResult {
    pub query_id: String,
    pub placeholder_id: String,
}

// ---------------------------------------------------------------------------
// Диалоги
// ---------------------------------------------------------------------------

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

fn tag_from_row(r: sqlx::sqlite::SqliteRow) -> Tag {
    Tag {
        id: r.get("id"),
        name: r.get("name"),
        display_name: r.get("display_name"),
        source: r.get("source"),
        created_at: r.get("created_at"),
    }
}

/// Весь справочник тегов (для подсказок ввода и LLM-сверки).
pub async fn list_tags(pool: &SqlitePool) -> Result<Vec<Tag>, sqlx::Error> {
    let rows = sqlx::query(
        "SELECT id, name, display_name, source, created_at
         FROM tags ORDER BY display_name ASC",
    )
    .fetch_all(pool)
    .await?;
    Ok(rows.into_iter().map(tag_from_row).collect())
}

/// Найти тег в справочнике по нормализованному имени.
pub async fn get_tag_by_name(
    pool: &SqlitePool,
    name: &str,
) -> Result<Option<Tag>, sqlx::Error> {
    let row = sqlx::query(
        "SELECT id, name, display_name, source, created_at FROM tags WHERE name = ?",
    )
    .bind(name)
    .fetch_optional(pool)
    .await?;
    Ok(row.map(tag_from_row))
}

/// Получить тег из справочника или создать новый.
/// `display` — как ввёл человек/LLM; ключ дедупа — нормализованное имя.
/// `source` — "manual" | "llm" (происхождение нового тега).
pub async fn get_or_create_tag(
    pool: &SqlitePool,
    display: &str,
    source: &str,
) -> Result<Tag, String> {
    let name = normalize_tag(display).ok_or_else(|| "empty tag".to_string())?;
    if let Some(existing) = get_tag_by_name(pool, &name).await.map_err(|e| e.to_string())? {
        return Ok(existing);
    }

    // display_name — исходный регистр, но без ведущего '#' и пробелов по краям.
    let display_name = display.trim().trim_start_matches('#').trim();
    let display_name = if display_name.is_empty() { name.as_str() } else { display_name };

    let id = uuid::Uuid::new_v4().to_string();
    sqlx::query(
        "INSERT INTO tags (id, name, display_name, source) VALUES (?, ?, ?, ?)",
    )
    .bind(&id)
    .bind(&name)
    .bind(display_name)
    .bind(source)
    .execute(pool)
    .await
    .map_err(|e| e.to_string())?;

    get_tag_by_name(pool, &name)
        .await
        .map_err(|e| e.to_string())?
        .ok_or_else(|| "tag not found after insert".to_string())
}

/// Подсказка «похожих» тегов при вводе (нечёткое ранжирование):
/// точное совпадение → префикс → подстрока → малое расстояние Левенштейна
/// (терпит опечатки). Справочник мал — считаем в памяти.
pub async fn suggest_tags(
    pool: &SqlitePool,
    query: &str,
    limit: usize,
) -> Result<Vec<Tag>, sqlx::Error> {
    let q = match normalize_tag(query) {
        Some(q) => q,
        None => return Ok(Vec::new()),
    };
    let qlen = q.chars().count();
    let qs = q.as_str();
    let all = list_tags(pool).await?;

    let mut scored: Vec<(u8, usize, Tag)> = Vec::new();
    for t in all {
        let name_len = t.name.chars().count();
        let (tier, dist) = if t.name == q {
            (0u8, 0usize)
        } else if t.name.starts_with(qs) {
            (1, name_len.saturating_sub(qlen))
        } else if t.name.contains(qs) {
            (2, name_len)
        } else {
            let d = levenshtein(&t.name, qs);
            let threshold = (name_len.max(qlen) / 3).max(1);
            if d <= threshold {
                (3, d)
            } else {
                continue;
            }
        };
        scored.push((tier, dist, t));
    }

    scored.sort_by(|a, b| {
        a.0.cmp(&b.0)
            .then(a.1.cmp(&b.1))
            .then_with(|| a.2.display_name.cmp(&b.2.display_name))
    });

    Ok(scored.into_iter().take(limit).map(|(_, _, t)| t).collect())
}

/// Теги беседы (join к справочнику).
pub async fn get_dialog_tags(
    pool: &SqlitePool,
    dialog_id: &str,
) -> Result<Vec<Tag>, sqlx::Error> {
    let rows = sqlx::query(
        "SELECT t.id, t.name, t.display_name, t.source, t.created_at
         FROM dialog_tags dt
         INNER JOIN tags t ON t.id = dt.tag_id
         WHERE dt.dialog_id = ?
         ORDER BY t.display_name ASC",
    )
    .bind(dialog_id)
    .fetch_all(pool)
    .await?;
    Ok(rows.into_iter().map(tag_from_row).collect())
}

/// Привязать тег к беседе (по одному). Идемпотентно; держит лимит MAX_DIALOG_TAGS.
pub async fn add_dialog_tag(
    pool: &SqlitePool,
    dialog_id: &str,
    tag_id: &str,
) -> Result<(), String> {
    let already: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM dialog_tags WHERE dialog_id = ? AND tag_id = ?",
    )
    .bind(dialog_id)
    .bind(tag_id)
    .fetch_one(pool)
    .await
    .map_err(|e| e.to_string())?;
    if already > 0 {
        return Ok(());
    }

    let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM dialog_tags WHERE dialog_id = ?")
        .bind(dialog_id)
        .fetch_one(pool)
        .await
        .map_err(|e| e.to_string())?;
    if count as usize >= MAX_DIALOG_TAGS {
        return Err(format!("too many tags: maximum is {MAX_DIALOG_TAGS}"));
    }

    // OR IGNORE — защита от дубля поверх PRIMARY KEY (dialog_id, tag_id):
    // повторная привязка того же тега не создаёт второй строки.
    sqlx::query("INSERT OR IGNORE INTO dialog_tags (dialog_id, tag_id) VALUES (?, ?)")
        .bind(dialog_id)
        .bind(tag_id)
        .execute(pool)
        .await
        .map_err(|e| e.to_string())?;
    Ok(())
}

/// Отвязать тег от беседы (тег в справочнике остаётся).
pub async fn remove_dialog_tag(
    pool: &SqlitePool,
    dialog_id: &str,
    tag_id: &str,
) -> Result<(), String> {
    sqlx::query("DELETE FROM dialog_tags WHERE dialog_id = ? AND tag_id = ?")
        .bind(dialog_id)
        .bind(tag_id)
        .execute(pool)
        .await
        .map_err(|e| e.to_string())?;
    Ok(())
}

/// Задать ПОЛНЫЙ набор тегов беседы по списку строк (для плагинов и LLM-сверки).
/// Каждая строка проходит через справочник (get_or_create), затем связки беседы
/// заменяются на полученные tag_id. `source` — происхождение новых тегов.
pub async fn set_dialog_tags(
    pool: &SqlitePool,
    dialog_id: &str,
    displays: &[String],
    source: &str,
) -> Result<Vec<Tag>, String> {
    let exists: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM dialogs WHERE id = ?")
        .bind(dialog_id)
        .fetch_one(pool)
        .await
        .map_err(|e| e.to_string())?;
    if exists == 0 {
        return Err("dialog not found".into());
    }

    // Через справочник, с дедупом по id и сохранением порядка.
    let mut tags: Vec<Tag> = Vec::new();
    for raw in displays {
        if normalize_tag(raw).is_none() {
            continue;
        }
        let tag = get_or_create_tag(pool, raw, source).await?;
        if !tags.iter().any(|t| t.id == tag.id) {
            tags.push(tag);
        }
    }
    if tags.len() > MAX_DIALOG_TAGS {
        return Err(format!("too many tags: maximum is {MAX_DIALOG_TAGS}"));
    }

    let mut tx = pool.begin().await.map_err(|e| e.to_string())?;
    sqlx::query("DELETE FROM dialog_tags WHERE dialog_id = ?")
        .bind(dialog_id)
        .execute(&mut *tx)
        .await
        .map_err(|e| e.to_string())?;
    for tag in &tags {
        sqlx::query("INSERT INTO dialog_tags (dialog_id, tag_id) VALUES (?, ?)")
            .bind(dialog_id)
            .bind(&tag.id)
            .execute(&mut *tx)
            .await
            .map_err(|e| e.to_string())?;
    }
    tx.commit().await.map_err(|e| e.to_string())?;

    Ok(tags)
}

/// Подбор тегов для панели поиска: подстрока по имени, со счётчиком бесед
/// (беседы корзины не считаем и в выдачу теги без живых бесед не попадают).
pub async fn search_dialog_tags(
    pool: &SqlitePool,
    query: &str,
) -> Result<Vec<TagHit>, sqlx::Error> {
    let q = match normalize_tag(query) {
        Some(q) => q,
        None => return Ok(Vec::new()),
    };
    let like = format!("%{}%", escape_like(&q));

    let rows = sqlx::query(
        "SELECT t.id, t.name, t.display_name, t.source, t.created_at,
                COUNT(d.id) AS dialog_count
         FROM tags t
         LEFT JOIN dialog_tags dt ON dt.tag_id = t.id
         LEFT JOIN dialogs d
                ON d.id = dt.dialog_id
               AND (d.notebook_id IS NULL OR d.notebook_id != 'trash')
         WHERE t.name LIKE ? ESCAPE '\\'
         GROUP BY t.id
         HAVING dialog_count > 0
         ORDER BY t.display_name ASC",
    )
    .bind(&like)
    .fetch_all(pool)
    .await?;

    Ok(rows
        .into_iter()
        .map(|r| TagHit {
            dialog_count: r.get("dialog_count"),
            tag: tag_from_row(r),
        })
        .collect())
}

/// Беседы, помеченные тегом (плоский список, без корзины).
pub async fn list_dialogs_by_tag(
    pool: &SqlitePool,
    tag_id: &str,
) -> Result<Vec<DbDialog>, sqlx::Error> {
    let rows = sqlx::query(
        "SELECT d.id, d.notebook_id, d.root_node_id, d.active_leaf_id, d.title,
                d.use_knowledge_cards, d.created_at, d.updated_at
         FROM dialogs d
         INNER JOIN dialog_tags dt ON dt.dialog_id = d.id
         WHERE dt.tag_id = ?
           AND (d.notebook_id IS NULL OR d.notebook_id != 'trash')
         ORDER BY d.updated_at DESC",
    )
    .bind(tag_id)
    .fetch_all(pool)
    .await?;

    Ok(rows
        .into_iter()
        .map(|r| DbDialog {
            id: r.get("id"),
            notebook_id: r.get("notebook_id"),
            root_node_id: r.get("root_node_id"),
            active_leaf_id: r.get("active_leaf_id"),
            title: r.get("title"),
            use_knowledge_cards: r.get::<i64, _>("use_knowledge_cards") != 0,
            created_at: r.get("created_at"),
            updated_at: r.get("updated_at"),
        })
        .collect())
}

// ---------------------------------------------------------------------------
// Узлы
// ---------------------------------------------------------------------------

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
    let branch_name: Option<String> = if node_type == "user_message" {
        let name: String = content.chars().take(128).collect();
        Some(name)
    } else {
        None
    };

    sqlx::query(
        "INSERT INTO nodes
            (id, dialog_id, parent_id, node_type, content,
             model_id, model_role, tokens_count, branch_name)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)"
    )
    .bind(id)
    .bind(dialog_id)
    .bind(parent_id)
    .bind(node_type)
    .bind(content)
    .bind(model_id)
    .bind(model_role)
    .bind(tokens_count)
    .bind(&branch_name)
    .execute(pool)
    .await?;

    if let Some(pid) = parent_id {
        set_active_child(pool, pid, id).await?;
        increment_children_count(pool, pid).await?;
    }

    let dialog = get_dialog(pool, dialog_id).await?;
    if let Some(d) = dialog {
        if d.root_node_id.is_none() {
            sqlx::query("UPDATE dialogs SET root_node_id = ? WHERE id = ?")
                .bind(id)
                .bind(dialog_id)
                .execute(pool)
                .await?;
        }
    }

    update_dialog_leaf(pool, dialog_id, id).await?;
    get_node(pool, id).await?.ok_or(sqlx::Error::RowNotFound)
}

/// Узел-артефакт (D-023/D-092): файл в extra.artifact, content — отображаемое имя.
pub async fn create_artifact_node(
    pool: &SqlitePool,
    id: &str,
    dialog_id: &str,
    parent_id: &str,
    content: &str,
    extra_json: &str,
) -> Result<DbNode, sqlx::Error> {
    sqlx::query(
        "INSERT INTO nodes (id, dialog_id, parent_id, node_type, content, extra)
         VALUES (?, ?, ?, 'artifact', ?, ?)",
    )
    .bind(id)
    .bind(dialog_id)
    .bind(parent_id)
    .bind(content)
    .bind(extra_json)
    .execute(pool)
    .await?;

    set_active_child(pool, parent_id, id).await?;
    increment_children_count(pool, parent_id).await?;
    update_dialog_leaf(pool, dialog_id, id).await?;
    get_node(pool, id).await?.ok_or(sqlx::Error::RowNotFound)
}

/// Отправка пользовательского сообщения: атомарно создаёт Q-узел и
/// под ним служебную заглушку-ответ (unanswered_placeholder).
///
/// Заглушка ставится ВСЕГДА, до обращения к LLM — это устойчивость к сбоям:
/// если приложение упадёт / пользователь уйдёт до ответа, структура уже
/// регулярна (Q→A), холостого Q без ответа не возникает.
///
/// При успешном ответе вызывающий код зовёт resolve_answer(placeholder_id, ...).
/// content заглушки пустой: она опознаётся по node_type, не по тексту (ср. D-061).
pub async fn send_user_message(
    pool: &SqlitePool,
    dialog_id: &str,
    parent_id: Option<&str>,
    content: &str,
) -> Result<SendResult, sqlx::Error> {
    // 1. Q-узел обычным путём (active_child у родителя, children_count,
    //    root_node_id при необходимости, курсор диалога → Q).
    let query_id = uuid::Uuid::new_v4().to_string();
    create_node(
        pool,
        &query_id,
        dialog_id,
        parent_id,
        "user_message",
        content,
        None,
        None,
        0,
    )
    .await?;

    // 2. Заглушка-ответ под Q. create_node сдвинет курсор диалога на неё
    //    и проставит active_child у Q.
    let placeholder_id = uuid::Uuid::new_v4().to_string();
    create_node(
        pool,
        &placeholder_id,
        dialog_id,
        Some(&query_id),
        "unanswered_placeholder",
        "",
        None,
        None,
        0,
    )
    .await?;

    Ok(SendResult { query_id, placeholder_id })
}

/// Перезаписать заглушку реальным ответом LLM.
/// unanswered_placeholder → assistant_message (UPDATE, не INSERT): id узла и
/// его место в дереве сохраняются.
///
/// Проверяет, что узел всё ещё заглушка — защита от двойной доставки/гонок.
/// Если узел уже не unanswered_placeholder — ошибка, узел не трогается.
pub async fn resolve_answer(
    pool: &SqlitePool,
    placeholder_id: &str,
    content: &str,
    model_id: Option<&str>,
    model_role: Option<&str>,
    plugin_id: Option<&str>,
    tokens_count: i64,
    extra: Option<&str>,
) -> Result<DbNode, sqlx::Error> {
    let node = get_node(pool, placeholder_id)
        .await?
        .ok_or(sqlx::Error::RowNotFound)?;

    if node.node_type != "unanswered_placeholder" {
        return Err(sqlx::Error::Protocol(format!(
            "resolve_answer: node {} is '{}', not an unanswered_placeholder",
            placeholder_id, node.node_type
        )));
    }

    sqlx::query(
        "UPDATE nodes
         SET node_type = 'assistant_message',
             content = ?,
             model_id = ?,
             model_role = ?,
             plugin_id = ?,
             tokens_count = ?,
             extra = COALESCE(?, extra)
         WHERE id = ?"
    )
    .bind(content)
    .bind(model_id)
    .bind(model_role)
    .bind(plugin_id)
    .bind(tokens_count)
    .bind(extra)
    .bind(placeholder_id)
    .execute(pool)
    .await?;

    get_node(pool, placeholder_id)
        .await?
        .ok_or(sqlx::Error::RowNotFound)
}

pub async fn get_node(
    pool: &SqlitePool,
    id: &str,
) -> Result<Option<DbNode>, sqlx::Error> {
    let row = sqlx::query(
        "SELECT id, parent_id, dialog_id, node_type, content, active_child_id,
                model_id, model_role, plugin_id, tokens_count, is_pinned, is_protected,
                compression_level, extra, created_at,
                branch_name, last_visited_leaf_id, children_count, is_deleted
         FROM nodes WHERE id = ?"
    )
    .bind(id)
    .fetch_optional(pool)
    .await?;

    Ok(row.map(node_from_row))
}

/// Видимые дети узла (is_deleted = 0). Основной путь навигации.
pub async fn get_children(
    pool: &SqlitePool,
    parent_id: &str,
) -> Result<Vec<DbNode>, sqlx::Error> {
    let rows = sqlx::query(
        "SELECT id, parent_id, dialog_id, node_type, content, active_child_id,
                model_id, model_role, plugin_id, tokens_count, is_pinned, is_protected,
                compression_level, extra, created_at,
                branch_name, last_visited_leaf_id, children_count, is_deleted
         FROM nodes WHERE parent_id = ? AND is_deleted = 0 ORDER BY created_at ASC"
    )
    .bind(parent_id)
    .fetch_all(pool)
    .await?;

    Ok(rows.into_iter().map(node_from_row).collect())
}

/// Удалённые дети узла (is_deleted = 1). Для индикатора ⑂ в подвале A-узла (D-050).
pub async fn get_deleted_children(
    pool: &SqlitePool,
    parent_id: &str,
) -> Result<Vec<DbNode>, sqlx::Error> {
    let rows = sqlx::query(
        "SELECT id, parent_id, dialog_id, node_type, content, active_child_id,
                model_id, model_role, plugin_id, tokens_count, is_pinned, is_protected,
                compression_level, extra, created_at,
                branch_name, last_visited_leaf_id, children_count, is_deleted
         FROM nodes WHERE parent_id = ? AND is_deleted = 1 ORDER BY created_at ASC"
    )
    .bind(parent_id)
    .fetch_all(pool)
    .await?;

    Ok(rows.into_iter().map(node_from_row).collect())
}

/// Мягкое удаление ветки: помечает узел и всё его поддерево как is_deleted = 1.
/// Безопасно — в дереве нет сходящихся веток, поддерево изолировано (D-048).
/// Если node_id — активная ветка диалога, вызывающий код должен
/// сначала переключить active_leaf на другую видимую ветку.
pub async fn delete_branch(
    pool: &SqlitePool,
    node_id: &str,
) -> Result<(), sqlx::Error> {
    sqlx::query(
        "WITH RECURSIVE subtree(id) AS (
             SELECT id FROM nodes WHERE id = ?
             UNION ALL
             SELECT n.id FROM nodes n
             INNER JOIN subtree s ON n.parent_id = s.id
         )
         UPDATE nodes SET is_deleted = 1 WHERE id IN (SELECT id FROM subtree)"
    )
    .bind(node_id)
    .execute(pool)
    .await?;
    Ok(())
}

/// Восстановление ветки: снимает is_deleted = 1 с узла и всего поддерева.
pub async fn restore_branch(
    pool: &SqlitePool,
    node_id: &str,
) -> Result<(), sqlx::Error> {
    sqlx::query(
        "WITH RECURSIVE subtree(id) AS (
             SELECT id FROM nodes WHERE id = ?
             UNION ALL
             SELECT n.id FROM nodes n
             INNER JOIN subtree s ON n.parent_id = s.id
         )
         UPDATE nodes SET is_deleted = 0 WHERE id IN (SELECT id FROM subtree)"
    )
    .bind(node_id)
    .execute(pool)
    .await?;
    Ok(())
}

pub async fn set_active_child(
    pool: &SqlitePool,
    node_id: &str,
    child_id: &str,
) -> Result<(), sqlx::Error> {
    sqlx::query("UPDATE nodes SET active_child_id = ? WHERE id = ?")
        .bind(child_id)
        .bind(node_id)
        .execute(pool)
        .await?;
    Ok(())
}

pub async fn increment_children_count(
    pool: &SqlitePool,
    node_id: &str,
) -> Result<(), sqlx::Error> {
    sqlx::query(
        "UPDATE nodes SET children_count = children_count + 1 WHERE id = ?"
    )
    .bind(node_id)
    .execute(pool)
    .await?;
    Ok(())
}

pub async fn set_branch_name(
    pool: &SqlitePool,
    node_id: &str,
    name: &str,
) -> Result<(), sqlx::Error> {
    sqlx::query("UPDATE nodes SET branch_name = ? WHERE id = ?")
        .bind(name)
        .bind(node_id)
        .execute(pool)
        .await?;
    Ok(())
}

pub async fn set_last_visited_leaf(
    pool: &SqlitePool,
    node_id: &str,
    leaf_id: &str,
) -> Result<(), sqlx::Error> {
    sqlx::query(
        "UPDATE nodes SET last_visited_leaf_id = ? WHERE id = ?"
    )
    .bind(leaf_id)
    .bind(node_id)
    .execute(pool)
    .await?;
    Ok(())
}

pub async fn get_branch(
    pool: &SqlitePool,
    dialog_id: &str,
) -> Result<Vec<DbNode>, sqlx::Error> {
    let dialog = get_dialog(pool, dialog_id)
        .await?
        .ok_or(sqlx::Error::RowNotFound)?;

    let leaf_id = match dialog.active_leaf_id {
        Some(id) => id,
        None => return Ok(vec![]),
    };

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
            None => break,
        }
    }

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
        plugin_id: r.get("plugin_id"),
        tokens_count: r.get("tokens_count"),
        is_pinned: r.get::<i64, _>("is_pinned") != 0,
        is_protected: r.get::<i64, _>("is_protected") != 0,
        compression_level: r.get("compression_level"),
        extra: r.get("extra"),
        created_at: r.get("created_at"),
        branch_name: r.get("branch_name"),
        last_visited_leaf_id: r.get("last_visited_leaf_id"),
        children_count: r.get("children_count"),
        is_deleted: r.get::<i64, _>("is_deleted") != 0,
    }
}

fn normalize_tag(raw: &str) -> Option<String> {
    let trimmed = raw.trim().trim_start_matches('#').trim();
    if trimmed.is_empty() {
        return None;
    }
    Some(trimmed.to_lowercase())
}

/// Экранирование спецсимволов LIKE (используем ESCAPE '\').
fn escape_like(s: &str) -> String {
    s.replace('\\', "\\\\")
        .replace('%', "\\%")
        .replace('_', "\\_")
}

/// Расстояние Левенштейна по символам (Unicode-корректно для кириллицы).
fn levenshtein(a: &str, b: &str) -> usize {
    let a: Vec<char> = a.chars().collect();
    let b: Vec<char> = b.chars().collect();
    if a.is_empty() {
        return b.len();
    }
    if b.is_empty() {
        return a.len();
    }

    let mut prev: Vec<usize> = (0..=b.len()).collect();
    let mut curr: Vec<usize> = vec![0; b.len() + 1];

    for (i, ca) in a.iter().enumerate() {
        curr[0] = i + 1;
        for (j, cb) in b.iter().enumerate() {
            let cost = if ca == cb { 0 } else { 1 };
            curr[j + 1] = (prev[j + 1] + 1)
                .min(curr[j] + 1)
                .min(prev[j] + cost);
        }
        std::mem::swap(&mut prev, &mut curr);
    }
    prev[b.len()]
}