// src-tauri/src/notebooks/mod.rs
//
// Vertical slice «блокноты»: владеет таблицей notebooks и связкой dialogs.notebook_id.
// Механизм (ядро), не политика: CRUD + иерархия + членство бесед + инварианты.
// Организация/смарт-правила/аналитика — это уже плагины (см. session10 summary).
//
// Инварианты (запрос сессии 11):
//   - максимальная глубина вложенности — 32 (корень = глубина 0);
//   - максимальное ветвление КОРНЕВОГО блокнота — 256 прямых нормальных детей;
//   - максимум бесед в одном блокноте — 1024;
//   - беседу нельзя создать прямо в корне — только в блокноте глубины >= 1;
//   - удаление блокнота/беседы = мягкий перенос в служебную «Корзину».

use crate::db::{self, DbDialog};
use sqlx::{Row, SqlitePool};

// Фиксированные id служебных блокнотов (сидятся миграцией 006).
pub const ROOT_ID: &str = "root";
pub const TRASH_ID: &str = "trash";

// Лимиты иерархии.
pub const MAX_DEPTH: i64 = 32;
pub const MAX_ROOT_BRANCHING: i64 = 256;
pub const MAX_DIALOGS_PER_NOTEBOOK: i64 = 1024;

/// Блокнот — контейнер для бесед и вложенных блокнотов.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct DbNotebook {
    pub id: String,
    pub parent_notebook_id: Option<String>,
    pub name: String,
    pub kind: String, // root | trash | normal
    pub knowledge_card_id: Option<String>,
    pub system_prompt: Option<String>,
    pub created_at: String,
}

fn notebook_from_row(r: sqlx::sqlite::SqliteRow) -> DbNotebook {
    DbNotebook {
        id: r.get("id"),
        parent_notebook_id: r.get("parent_notebook_id"),
        name: r.get("name"),
        kind: r.get("kind"),
        knowledge_card_id: r.get("knowledge_card_id"),
        system_prompt: r.get("system_prompt"),
        created_at: r.get("created_at"),
    }
}

const SELECT_NOTEBOOK: &str =
    "SELECT id, parent_notebook_id, name, kind, knowledge_card_id, system_prompt, created_at
     FROM notebooks";

// ---------------------------------------------------------------------------
// Чтение
// ---------------------------------------------------------------------------

pub async fn get_notebook(
    pool: &SqlitePool,
    id: &str,
) -> Result<Option<DbNotebook>, sqlx::Error> {
    let sql = format!("{SELECT_NOTEBOOK} WHERE id = ?");
    let row = sqlx::query(&sql).bind(id).fetch_optional(pool).await?;
    Ok(row.map(notebook_from_row))
}

/// Все блокноты плоским списком (фронт собирает дерево по parent_notebook_id).
pub async fn list_notebooks(pool: &SqlitePool) -> Result<Vec<DbNotebook>, sqlx::Error> {
    let sql = format!("{SELECT_NOTEBOOK} ORDER BY created_at ASC");
    let rows = sqlx::query(&sql).fetch_all(pool).await?;
    Ok(rows.into_iter().map(notebook_from_row).collect())
}

/// Беседы внутри блокнота.
pub async fn list_dialogs_in_notebook(
    pool: &SqlitePool,
    notebook_id: &str,
) -> Result<Vec<DbDialog>, sqlx::Error> {
    let rows = sqlx::query(
        "SELECT id, notebook_id, root_node_id, active_leaf_id, title,
                use_knowledge_cards, created_at, updated_at
         FROM dialogs WHERE notebook_id = ? ORDER BY updated_at DESC",
    )
    .bind(notebook_id)
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
// Геометрия дерева (для инвариантов)
// ---------------------------------------------------------------------------

/// Глубина блокнота: число предков до корня. Корень = 0.
async fn notebook_depth(pool: &SqlitePool, id: &str) -> Result<i64, sqlx::Error> {
    let depth: i64 = sqlx::query_scalar(
        "WITH RECURSIVE chain(id, parent, lvl) AS (
             SELECT id, parent_notebook_id, 0 FROM notebooks WHERE id = ?
             UNION ALL
             SELECT n.id, n.parent_notebook_id, c.lvl + 1
             FROM notebooks n JOIN chain c ON n.id = c.parent
         )
         SELECT COALESCE(MAX(lvl), 0) FROM chain",
    )
    .bind(id)
    .fetch_one(pool)
    .await?;
    Ok(depth)
}

/// Высота поддерева: макс. относительная глубина потомков (лист = 0).
async fn subtree_height(pool: &SqlitePool, id: &str) -> Result<i64, sqlx::Error> {
    let h: i64 = sqlx::query_scalar(
        "WITH RECURSIVE sub(id, lvl) AS (
             SELECT id, 0 FROM notebooks WHERE id = ?
             UNION ALL
             SELECT n.id, s.lvl + 1 FROM notebooks n JOIN sub s ON n.parent_notebook_id = s.id
         )
         SELECT COALESCE(MAX(lvl), 0) FROM sub",
    )
    .bind(id)
    .fetch_one(pool)
    .await?;
    Ok(h)
}

/// candidate входит в поддерево ancestor (включая сам ancestor)?
async fn is_in_subtree(
    pool: &SqlitePool,
    ancestor: &str,
    candidate: &str,
) -> Result<bool, sqlx::Error> {
    let cnt: i64 = sqlx::query_scalar(
        "WITH RECURSIVE sub(id) AS (
             SELECT id FROM notebooks WHERE id = ?
             UNION ALL
             SELECT n.id FROM notebooks n JOIN sub s ON n.parent_notebook_id = s.id
         )
         SELECT COUNT(*) FROM sub WHERE id = ?",
    )
    .bind(ancestor)
    .bind(candidate)
    .fetch_one(pool)
    .await?;
    Ok(cnt > 0)
}

/// Число прямых нормальных детей блокнота (служебные kind не считаем).
/// exclude — id, который не учитывать (перемещаемый узел, уже сидящий тут).
async fn count_normal_children(
    pool: &SqlitePool,
    parent_id: &str,
    exclude: Option<&str>,
) -> Result<i64, sqlx::Error> {
    let cnt: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM notebooks
         WHERE parent_notebook_id = ? AND kind = 'normal'
           AND (? IS NULL OR id != ?)",
    )
    .bind(parent_id)
    .bind(exclude)
    .bind(exclude)
    .fetch_one(pool)
    .await?;
    Ok(cnt)
}

async fn count_dialogs(
    pool: &SqlitePool,
    notebook_id: &str,
    exclude: Option<&str>,
) -> Result<i64, sqlx::Error> {
    let cnt: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM dialogs
         WHERE notebook_id = ? AND (? IS NULL OR id != ?)",
    )
    .bind(notebook_id)
    .bind(exclude)
    .bind(exclude)
    .fetch_one(pool)
    .await?;
    Ok(cnt)
}

// ---------------------------------------------------------------------------
// Блокноты — операции
// ---------------------------------------------------------------------------

/// Создать блокнот внутри parent_id. Для блокнота верхнего уровня parent_id = "root".
pub async fn create_notebook(
    pool: &SqlitePool,
    parent_id: &str,
    name: &str,
) -> Result<DbNotebook, String> {
    let name = name.trim();
    if name.is_empty() {
        return Err("имя блокнота не может быть пустым".into());
    }

    let parent = get_notebook(pool, parent_id)
        .await
        .map_err(|e| e.to_string())?
        .ok_or_else(|| "родительский блокнот не найден".to_string())?;

    if parent.kind == "trash" {
        return Err("нельзя создавать блокнот внутри корзины".into());
    }

    let parent_depth = notebook_depth(pool, parent_id)
        .await
        .map_err(|e| e.to_string())?;
    if parent_depth + 1 > MAX_DEPTH {
        return Err(format!(
            "превышена максимальная глубина вложенности ({MAX_DEPTH})"
        ));
    }

    if parent_id == ROOT_ID {
        let children = count_normal_children(pool, ROOT_ID, None)
            .await
            .map_err(|e| e.to_string())?;
        if children >= MAX_ROOT_BRANCHING {
            return Err(format!(
                "превышено максимальное ветвление корневого блокнота ({MAX_ROOT_BRANCHING})"
            ));
        }
    }

    let id = uuid::Uuid::new_v4().to_string();
    sqlx::query(
        "INSERT INTO notebooks (id, parent_notebook_id, name, kind)
         VALUES (?, ?, ?, 'normal')",
    )
    .bind(&id)
    .bind(parent_id)
    .bind(name)
    .execute(pool)
    .await
    .map_err(|e| e.to_string())?;

    get_notebook(pool, &id)
        .await
        .map_err(|e| e.to_string())?
        .ok_or_else(|| "не удалось прочитать созданный блокнот".to_string())
}

/// Переименовать пользовательский блокнот. Служебные (root/trash) не трогаем.
pub async fn rename_notebook(
    pool: &SqlitePool,
    id: &str,
    name: &str,
) -> Result<(), String> {
    let name = name.trim();
    if name.is_empty() {
        return Err("имя блокнота не может быть пустым".into());
    }

    let nb = get_notebook(pool, id)
        .await
        .map_err(|e| e.to_string())?
        .ok_or_else(|| "блокнот не найден".to_string())?;
    if nb.kind != "normal" {
        return Err("служебный блокнот переименовать нельзя".into());
    }

    sqlx::query("UPDATE notebooks SET name = ? WHERE id = ?")
        .bind(name)
        .bind(id)
        .execute(pool)
        .await
        .map_err(|e| e.to_string())?;
    Ok(())
}

/// Переподчинить блокнот: id -> внутрь new_parent_id.
/// Проверки: не служебный, нет цикла, глубина поддерева <= 32, ветвление корня.
pub async fn move_notebook(
    pool: &SqlitePool,
    id: &str,
    new_parent_id: &str,
) -> Result<(), String> {
    let nb = get_notebook(pool, id)
        .await
        .map_err(|e| e.to_string())?
        .ok_or_else(|| "блокнот не найден".to_string())?;
    if nb.kind != "normal" {
        return Err("служебный блокнот перемещать нельзя".into());
    }

    let new_parent = get_notebook(pool, new_parent_id)
        .await
        .map_err(|e| e.to_string())?
        .ok_or_else(|| "целевой блокнот не найден".to_string())?;
    if new_parent.kind == "trash" {
        return Err("для удаления блокнота используйте корзину (удаление)".into());
    }

    if new_parent_id == id {
        return Err("блокнот нельзя вложить сам в себя".into());
    }
    // Цикл: целевой родитель не должен лежать внутри перемещаемого поддерева.
    if is_in_subtree(pool, id, new_parent_id)
        .await
        .map_err(|e| e.to_string())?
    {
        return Err("нельзя переместить блокнот внутрь его собственного потомка".into());
    }

    let new_parent_depth = notebook_depth(pool, new_parent_id)
        .await
        .map_err(|e| e.to_string())?;
    let height = subtree_height(pool, id).await.map_err(|e| e.to_string())?;
    if new_parent_depth + 1 + height > MAX_DEPTH {
        return Err(format!(
            "перемещение превысит максимальную глубину вложенности ({MAX_DEPTH})"
        ));
    }

    if new_parent_id == ROOT_ID {
        let children = count_normal_children(pool, ROOT_ID, Some(id))
            .await
            .map_err(|e| e.to_string())?;
        if children >= MAX_ROOT_BRANCHING {
            return Err(format!(
                "превышено максимальное ветвление корневого блокнота ({MAX_ROOT_BRANCHING})"
            ));
        }
    }

    sqlx::query("UPDATE notebooks SET parent_notebook_id = ? WHERE id = ?")
        .bind(new_parent_id)
        .bind(id)
        .execute(pool)
        .await
        .map_err(|e| e.to_string())?;
    Ok(())
}

/// Удалить блокнот = мягко перенести в корзину (вместе со всем поддеревом
/// и беседами — они едут как потомки, ничего не разрушается).
pub async fn delete_notebook(pool: &SqlitePool, id: &str) -> Result<(), String> {
    let nb = get_notebook(pool, id)
        .await
        .map_err(|e| e.to_string())?
        .ok_or_else(|| "блокнот не найден".to_string())?;
    if nb.kind != "normal" {
        return Err("служебный блокнот удалить нельзя".into());
    }

    sqlx::query("UPDATE notebooks SET parent_notebook_id = ? WHERE id = ?")
        .bind(TRASH_ID)
        .bind(id)
        .execute(pool)
        .await
        .map_err(|e| e.to_string())?;
    Ok(())
}

// ---------------------------------------------------------------------------
// Беседы — членство в блокнотах
// ---------------------------------------------------------------------------

/// Создать беседу в блокноте. Нельзя в корне и в корзине; лимит 1024 на блокнот.
pub async fn create_dialog_in_notebook(
    pool: &SqlitePool,
    notebook_id: &str,
    title: &str,
) -> Result<DbDialog, String> {
    let nb = get_notebook(pool, notebook_id)
        .await
        .map_err(|e| e.to_string())?
        .ok_or_else(|| "блокнот не найден".to_string())?;
    if nb.kind == "root" {
        return Err("нельзя создать беседу прямо в корневом блокноте".into());
    }
    if nb.kind == "trash" {
        return Err("нельзя создать беседу в корзине".into());
    }

    let count = count_dialogs(pool, notebook_id, None)
        .await
        .map_err(|e| e.to_string())?;
    if count >= MAX_DIALOGS_PER_NOTEBOOK {
        return Err(format!(
            "превышено максимальное число бесед в блокноте ({MAX_DIALOGS_PER_NOTEBOOK})"
        ));
    }

    let id = uuid::Uuid::new_v4().to_string();
    db::create_dialog(pool, &id, title, Some(notebook_id))
        .await
        .map_err(|e| e.to_string())
}

/// Переподчинить беседу в другой блокнот. Те же запреты (корень/корзина) и лимит.
pub async fn move_dialog(
    pool: &SqlitePool,
    dialog_id: &str,
    new_notebook_id: &str,
) -> Result<(), String> {
    db::get_dialog(pool, dialog_id)
        .await
        .map_err(|e| e.to_string())?
        .ok_or_else(|| "беседа не найдена".to_string())?;

    let nb = get_notebook(pool, new_notebook_id)
        .await
        .map_err(|e| e.to_string())?
        .ok_or_else(|| "целевой блокнот не найден".to_string())?;
    if nb.kind == "root" {
        return Err("нельзя переместить беседу прямо в корневой блокнот".into());
    }
    if nb.kind == "trash" {
        return Err("для удаления беседы используйте корзину (удаление)".into());
    }

    let count = count_dialogs(pool, new_notebook_id, Some(dialog_id))
        .await
        .map_err(|e| e.to_string())?;
    if count >= MAX_DIALOGS_PER_NOTEBOOK {
        return Err(format!(
            "превышено максимальное число бесед в блокноте ({MAX_DIALOGS_PER_NOTEBOOK})"
        ));
    }

    sqlx::query("UPDATE dialogs SET notebook_id = ? WHERE id = ?")
        .bind(new_notebook_id)
        .bind(dialog_id)
        .execute(pool)
        .await
        .map_err(|e| e.to_string())?;
    Ok(())
}

/// Удалить беседу = мягко перенести в корзину.
pub async fn delete_dialog(pool: &SqlitePool, dialog_id: &str) -> Result<(), String> {
    db::get_dialog(pool, dialog_id)
        .await
        .map_err(|e| e.to_string())?
        .ok_or_else(|| "беседа не найдена".to_string())?;

    sqlx::query("UPDATE dialogs SET notebook_id = ? WHERE id = ?")
        .bind(TRASH_ID)
        .bind(dialog_id)
        .execute(pool)
        .await
        .map_err(|e| e.to_string())?;
    Ok(())
}
