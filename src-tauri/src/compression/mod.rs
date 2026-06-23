// src-tauri/src/compression/mod.rs
//
// Крепление сжатого диапазона (D-060/D-061/D-065/D-088).
//
// ГРАНИЦА ядро/плагин (D-066): этот модуль — ЯДРОВАЯ часть. Он НЕ сжимает текст
// (это политика плагина) — он только КРЕПИТ готовый результат в дерево:
//   1. узел-резюме S (compressed_summary) веткой-сестрой к верхнему A (D-060);
//   2. под ним заглушку (compression_placeholder) БЕЗ вызова LLM (D-061);
//   3. extra.compression на S (D-065): границы/время — ядро; plugin_id/version/
//      algorithm/params — плагин (непрозрачно для ядра);
//   4. провенанс модели на S (D-088): model_id = модель-уплотнитель (None для
//      детерминированного компрессора-заглушки), model_role = 'compression'.
//
// Топология (на одной ли линии start..end, не задет ли удалённый узел)
// переиспользует markers::resolve_linear_range — единый источник правды (D-066).

use crate::db;
use crate::markers;
use sqlx::{Row, SqlitePool};

/// Самоописание плагина-уплотнителя (D-065). Поля НЕПРОЗРАЧНЫ для ядра —
/// складываются в extra.compression как есть. JS присылает camelCase
/// (pluginId/pluginVersion), поэтому rename_all.
#[derive(Debug, Clone, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CompressionProvenance {
    pub plugin_id: String,
    pub plugin_version: String,
    pub algorithm: String,
    pub params: serde_json::Value,
}

/// Результат крепления — id обоих созданных служебных узлов.
#[derive(Debug, serde::Serialize)]
pub struct AttachResult {
    pub summary_node_id: String,
    pub placeholder_node_id: String,
}

/// Прикрепить сжатый диапазон start..end.
///
/// start — верхний A-узел (маркер), к нему крепится S веткой-сестрой.
/// end   — нижняя граница диапазона (маркер или лист), нужна для extra и
///         валидации линейности; сам контент резюме формирует ПЛАГИН (summary_text).
///
/// Курсор диалога после крепления уходит на заглушку под S (create_node ведёт
/// leaf за последним созданным узлом) — пользователь продолжает работу от S.
pub async fn attach_compressed(
    pool: &SqlitePool,
    start_node_id: &str,
    end_node_id: &str,
    summary_text: &str,
    placeholder_text: Option<&str>,
    model_id: Option<&str>,
    provenance: CompressionProvenance,
) -> Result<AttachResult, String> {
    if start_node_id == end_node_id {
        return Err("compression range is empty (start == end)".to_string());
    }

    // Верхняя граница — всегда A-узел (маркер живёт только на assistant_message,
    // D-058). Заодно даёт dialog_id для создаваемых узлов.
    let start = db::get_node(pool, start_node_id)
        .await
        .map_err(|e| e.to_string())?
        .ok_or_else(|| "start node not found".to_string())?;

    if start.node_type != "assistant_message" {
        return Err(format!(
            "compression start must be assistant_message, got '{}'",
            start.node_type
        ));
    }

    // Валидация линейности и «живости» диапазона переиспользует ядровую топологию
    // (D-066): ошибка, если start не предок end на одной линии либо путь задевает
    // удалённый узел. Сам путь нам не нужен — только факт прохождения проверки.
    markers::resolve_linear_range(pool, start_node_id, end_node_id).await?;

    let dialog_id = start.dialog_id.clone();

    // 1. Узел-резюме S: Q-слот, сестра старого продолжения (D-060). Провенанс
    //    модели — сразу на создании (D-088): model_role='compression' всегда,
    //    model_id = модель-уплотнитель (None для заглушки-компрессора).
    let summary_id = uuid::Uuid::new_v4().to_string();
    db::create_node(
        pool,
        &summary_id,
        &dialog_id,
        Some(start_node_id),
        "compressed_summary",
        summary_text,
        model_id,
        Some("compression"),
        0,
    )
    .await
    .map_err(|e| e.to_string())?;

    // 2. extra.compression на S (D-065). created_at берём из самого узла S —
    //    его проставила БД на INSERT, отдельный источник времени не нужен.
    let s_node = db::get_node(pool, &summary_id)
        .await
        .map_err(|e| e.to_string())?
        .ok_or_else(|| "summary node not found after insert".to_string())?;

    let extra = serde_json::json!({
        "compression": {
            // --- ядро ---
            "start_node_id": start_node_id,
            "end_node_id": end_node_id,
            "created_at": s_node.created_at,
            // --- плагин (непрозрачно для ядра) ---
            "plugin_id": provenance.plugin_id,
            "plugin_version": provenance.plugin_version,
            "algorithm": provenance.algorithm,
            "params": provenance.params,
        }
    });

    sqlx::query("UPDATE nodes SET extra = ? WHERE id = ?")
        .bind(extra.to_string())
        .bind(&summary_id)
        .execute(pool)
        .await
        .map_err(|e| e.to_string())?;

    // 3. Заглушка в A-слоте под S (D-061): сохраняет чередование Q->A, в модель
    //    НЕ идёт (опознаётся по node_type), без вызова LLM. Текст — от плагина
    //    (может быть пустым).
    let placeholder_id = uuid::Uuid::new_v4().to_string();
    db::create_node(
        pool,
        &placeholder_id,
        &dialog_id,
        Some(&summary_id),
        "compression_placeholder",
        placeholder_text.unwrap_or(""),
        None,
        None,
        0,
    )
    .await
    .map_err(|e| e.to_string())?;

    Ok(AttachResult {
        summary_node_id: summary_id,
        placeholder_node_id: placeholder_id,
    })
}

/// Прочитать метрику происхождения сжатия с узла S (D-065).
/// Возвращает сырой JSON extra.compression — для показа провенанса/отладки.
/// Пока не вызывается из UI; заведено как штатная точка чтения, чтобы доступ к
/// extra.compression не растекался сырым SQL по фронту.
pub async fn get_compression_meta(
    pool: &SqlitePool,
    summary_node_id: &str,
) -> Result<Option<serde_json::Value>, String> {
    let row = sqlx::query("SELECT extra FROM nodes WHERE id = ?")
        .bind(summary_node_id)
        .fetch_optional(pool)
        .await
        .map_err(|e| e.to_string())?;

    let extra: Option<String> = row.and_then(|r| r.get("extra"));
    match extra {
        Some(s) => {
            let v: serde_json::Value =
                serde_json::from_str(&s).map_err(|e| e.to_string())?;
            Ok(Some(v["compression"].clone()))
        }
        None => Ok(None),
    }
}
