// src-tauri/src/markers/mod.rs
//
// Маркеры (D-058) — персистентные именованные точки на A-узлах.
// Первый потребитель — сжатие (границы диапазона, D-057/D-059).
//
// Этот модуль владеет таблицей `markers` напрямую (vertical slice).
// Топология (D-066) реализована через публичные db::* — без сырого SQL к nodes
// и без правок db/mod.rs. Цена — N запросов на обход поддерева (MVP-приемлемо).
//
// Зависит от migration 005 (таблица markers).
// Не забыть: `mod markers;` в lib.rs рядом с `mod db;` / `mod tree;`.

use crate::db;
use sqlx::{Row, SqlitePool};
use std::collections::HashMap;

/// Маркер — постоянная именованная точка на A-узле (D-058).
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct Marker {
    pub id: String,
    pub node_id: String,
    pub label: String,
    pub comment: Option<String>,
    pub created_at: String,
}

/// Кандидат-конец диапазона (выдача list_reachable_ends, шаг 2 в D-068).
/// Узел может быть маркером, листом, или и тем и другим одновременно.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct ReachableEnd {
    pub node_id: String,
    pub marker_id: Option<String>, // Some — если конец размечен маркером
    pub label: Option<String>,     // имя маркера, если есть
    pub is_leaf: bool,             // узел — лист видимого поддерева
}

fn marker_from_row(r: sqlx::sqlite::SqliteRow) -> Marker {
    Marker {
        id: r.get("id"),
        node_id: r.get("node_id"),
        label: r.get("label"),
        comment: r.get("comment"),
        created_at: r.get("created_at"),
    }
}

// ---------------------------------------------------------------------------
// CRUD
// ---------------------------------------------------------------------------

/// Поставить маркер на A-узел.
/// Инвариант D-058: маркер допустим ТОЛЬКО на assistant_message.
/// Проверку держит ядро — БД её выразить не может (нет CHECK с подзапросом).
pub async fn create_marker(
    pool: &SqlitePool,
    node_id: &str,
    label: &str,
    comment: Option<&str>,
) -> Result<Marker, String> {
    let node = db::get_node(pool, node_id)
        .await
        .map_err(|e| e.to_string())?
        .ok_or_else(|| "node not found".to_string())?;

    if node.node_type != "assistant_message" {
        return Err(format!(
            "marker allowed only on assistant_message, got '{}'",
            node.node_type
        ));
    }

    let id = uuid::Uuid::new_v4().to_string();

    // created_at проставляем здесь: migration 005 не имеет DEFAULT на этом поле.
    sqlx::query(
        "INSERT INTO markers (id, node_id, label, comment, created_at)
         VALUES (?, ?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))",
    )
    .bind(&id)
    .bind(node_id)
    .bind(label)
    .bind(comment)
    .execute(pool)
    .await
    .map_err(|e| e.to_string())?;

    get_marker(pool, &id)
        .await?
        .ok_or_else(|| "marker not found after insert".to_string())
}

pub async fn get_marker(pool: &SqlitePool, id: &str) -> Result<Option<Marker>, String> {
    let row = sqlx::query(
        "SELECT id, node_id, label, comment, created_at FROM markers WHERE id = ?",
    )
    .bind(id)
    .fetch_optional(pool)
    .await
    .map_err(|e| e.to_string())?;

    Ok(row.map(marker_from_row))
}

/// Все маркеры на конкретном узле.
pub async fn get_markers_for_node(
    pool: &SqlitePool,
    node_id: &str,
) -> Result<Vec<Marker>, String> {
    let rows = sqlx::query(
        "SELECT id, node_id, label, comment, created_at
         FROM markers WHERE node_id = ? ORDER BY created_at ASC",
    )
    .bind(node_id)
    .fetch_all(pool)
    .await
    .map_err(|e| e.to_string())?;

    Ok(rows.into_iter().map(marker_from_row).collect())
}

/// Все маркеры диалога.
/// dialog_id в markers НЕ хранится (анти-денормализация — та же логика, что в
/// D-067). Берём join'ом к nodes как к источнику истины. is_deleted здесь НЕ
/// фильтруем — это полный список; фильтрация под startable — в топо-слое.
pub async fn list_markers_for_dialog(
    pool: &SqlitePool,
    dialog_id: &str,
) -> Result<Vec<Marker>, String> {
    let rows = sqlx::query(
        "SELECT m.id, m.node_id, m.label, m.comment, m.created_at
         FROM markers m
         INNER JOIN nodes n ON n.id = m.node_id
         WHERE n.dialog_id = ?
         ORDER BY m.created_at ASC",
    )
    .bind(dialog_id)
    .fetch_all(pool)
    .await
    .map_err(|e| e.to_string())?;

    Ok(rows.into_iter().map(marker_from_row).collect())
}

/// Обновить имя/комментарий (D-058: маркер редактируем как примечание).
pub async fn update_marker(
    pool: &SqlitePool,
    id: &str,
    label: &str,
    comment: Option<&str>,
) -> Result<(), String> {
    sqlx::query("UPDATE markers SET label = ?, comment = ? WHERE id = ?")
        .bind(label)
        .bind(comment)
        .bind(id)
        .execute(pool)
        .await
        .map_err(|e| e.to_string())?;
    Ok(())
}

/// Удалить маркер. Запрещено, пока на его node_id ссылается операция (D-067).
/// Признак «используется» ВЫЧИСЛЯЕТСЯ, не хранится флагом.
pub async fn delete_marker(pool: &SqlitePool, id: &str) -> Result<(), String> {
    let marker = get_marker(pool, id)
        .await?
        .ok_or_else(|| "marker not found".to_string())?;

    if is_node_referenced_by_compression(pool, &marker.node_id).await? {
        return Err(
            "cannot delete marker: its node is referenced by a compression".to_string(),
        );
    }

    sqlx::query("DELETE FROM markers WHERE id = ?")
        .bind(id)
        .execute(pool)
        .await
        .map_err(|e| e.to_string())?;
    Ok(())
}

// ---------------------------------------------------------------------------
// Целостность (D-067)
// ---------------------------------------------------------------------------

/// Ссылается ли хоть один compressed_summary на данный node_id как на границу
/// диапазона (extra.compression.start_node_id / end_node_id, D-065).
///
/// MVP: сканируем все compressed_summary и парсим extra в Rust. Реестр обратных
/// ссылок — отложенная оптимизация (D-067); сейчас S-узлов ноль.
///
/// СЛОЙ: единственный сырой SQL к nodes здесь — временно. Дом запроса появится
/// вместе с attach_compressed (он эти S-узлы и создаёт).
pub async fn is_node_referenced_by_compression(
    pool: &SqlitePool,
    node_id: &str,
) -> Result<bool, String> {
    let rows = sqlx::query(
        "SELECT extra FROM nodes
         WHERE node_type = 'compressed_summary' AND extra IS NOT NULL",
    )
    .fetch_all(pool)
    .await
    .map_err(|e| e.to_string())?;

    for r in rows {
        let extra: String = r.get("extra");
        let value: serde_json::Value = match serde_json::from_str(&extra) {
            Ok(v) => v,
            Err(_) => continue,
        };

        let comp = &value["compression"];
        if comp["start_node_id"].as_str() == Some(node_id)
            || comp["end_node_id"].as_str() == Some(node_id)
        {
            return Ok(true);
        }
    }

    Ok(false)
}

// ---------------------------------------------------------------------------
// Топология (D-066)
// ---------------------------------------------------------------------------

/// Маркеры, годные как НАЧАЛО диапазона (D-068, шаг 1).
/// Startable ⟺ узел маркера видим (не is_deleted) И имеет ≥1 видимого ребёнка
/// (не-лист — есть что сжимать вниз).
pub async fn list_startable_markers(
    pool: &SqlitePool,
    dialog_id: &str,
) -> Result<Vec<Marker>, String> {
    let markers = list_markers_for_dialog(pool, dialog_id).await?;
    let mut out = Vec::new();

    for m in markers {
        let node = match db::get_node(pool, &m.node_id).await.map_err(|e| e.to_string())? {
            Some(n) => n,
            None => continue,
        };
        if node.is_deleted {
            continue;
        }
        let children = db::get_children(pool, &m.node_id).await.map_err(|e| e.to_string())?;
        if !children.is_empty() {
            out.push(m);
        }
    }

    Ok(out)
}

/// Достижимые КОНЦЫ диапазона от заданного начала (D-068, шаг 2).
/// Кандидаты = видимые потомки `from`, которые либо маркеры, либо листья.
/// Любой потомок коллинеарен `from` по построению — это просто меню для D-068.
///
/// ИМЯ: в D-066 функция названа `list_reachable_markers`. Переименовал в
/// `list_reachable_ends`, т.к. она возвращает и листья без маркеров (D-059).
/// Предлагаю обновить D-066/глоссарий — см. заметку после файла.
pub async fn list_reachable_ends(
    pool: &SqlitePool,
    from_node_id: &str,
) -> Result<Vec<ReachableEnd>, String> {
    let from_node = db::get_node(pool, from_node_id)
        .await
        .map_err(|e| e.to_string())?
        .ok_or_else(|| "from node not found".to_string())?;

    if from_node.is_deleted {
        return Err("from node is deleted".to_string());
    }

    // Обход видимого поддерева через публичный db::get_children.
    // Собираем (узел, is_leaf), сам from исключён.
    let mut subtree: Vec<(db::DbNode, bool)> = Vec::new();
    let mut stack: Vec<db::DbNode> =
        db::get_children(pool, from_node_id).await.map_err(|e| e.to_string())?;

    while let Some(node) = stack.pop() {
        let children = db::get_children(pool, &node.id).await.map_err(|e| e.to_string())?;
        let is_leaf = children.is_empty();
        for c in children {
            stack.push(c);
        }
        subtree.push((node, is_leaf));
    }

    // Маркеры поддерева — одним запросом, группируем по node_id (без N+1).
    let all_markers = list_markers_for_dialog(pool, &from_node.dialog_id).await?;
    let mut markers_by_node: HashMap<String, Vec<Marker>> = HashMap::new();
    for m in all_markers {
        markers_by_node.entry(m.node_id.clone()).or_default().push(m);
    }

    let mut ends = Vec::new();
    for (node, is_leaf) in subtree {
        match markers_by_node.get(&node.id) {
            Some(markers) => {
                // Узел размечен: по элементу на маркер (на узле может быть >1).
                for m in markers {
                    ends.push(ReachableEnd {
                        node_id: node.id.clone(),
                        marker_id: Some(m.id.clone()),
                        label: Some(m.label.clone()),
                        is_leaf,
                    });
                }
            }
            None => {
                // Немаркированный узел — кандидат, только если это лист.
                // Промежуточный без маркера в меню не показываем (D-068).
                if is_leaf {
                    ends.push(ReachableEnd {
                        node_id: node.id.clone(),
                        marker_id: None,
                        label: None,
                        is_leaf: true,
                    });
                }
            }
        }
    }

    Ok(ends)
}

/// Линеаризовать диапазон start..end (D-066). Чистая топология.
/// Возвращает ИНКЛЮЗИВНЫЙ путь, верхний узел (start) — первым элементом.
/// Слой сжатия сам решает, что делать с якорем (D-063).
///
/// Ошибка, если start и end не на одной линии, либо если путь задевает
/// удалённый узел (решение: мёртвую линию не сжимаем).
pub async fn resolve_linear_range(
    pool: &SqlitePool,
    start_node_id: &str,
    end_node_id: &str,
) -> Result<Vec<db::DbNode>, String> {
    let mut path: Vec<db::DbNode> = Vec::new();
    let mut current = end_node_id.to_string();

    loop {
        let node = db::get_node(pool, &current)
            .await
            .map_err(|e| e.to_string())?
            .ok_or_else(|| "node not found in range".to_string())?;

        if node.is_deleted {
            return Err("range touches a deleted node".to_string());
        }

        let parent_id = node.parent_id.clone();
        let hit_start = node.id == start_node_id;
        path.push(node);

        if hit_start {
            path.reverse();
            return Ok(path);
        }

        match parent_id {
            Some(pid) => current = pid,
            None => return Err("start and end are not on the same line".to_string()),
        }
    }
}