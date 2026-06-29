// Хранилище конфигов плагинов (D-095).
// По файлу на плагин: app_data_dir/config/<plugin_id>.json — человекочитаемый
// текст, правится руками или сторонним инструментом. ЯДРО владеет путём,
// неймспейсингом и форматом; плагин отдаёт/получает СВОЙ конфиг как
// непрозрачный текст (см. cap.config в capabilities.ts). Вне БД диалогов и
// вне localStorage — развязка осей «настройки плагина» / «инструменты диалога».

use std::fs;
use std::path::{Path, PathBuf};

/// Каталог конфигов — сосед aizavr.db в app_data_dir.
fn config_dir(data_dir: &str) -> PathBuf {
    Path::new(data_dir).join("config")
}

/// Только [a-z0-9_-]: защита от path traversal и кросс-неймспейсного доступа.
/// plugin_id ядро берёт из манифеста (плагин его не подставляет), но валидируем
/// на всякий случай — каталог конфигов не должен зависеть от формы id.
fn sanitize_plugin_id(plugin_id: &str) -> Result<&str, String> {
    if plugin_id.is_empty() {
        return Err("empty plugin_id".into());
    }
    let ok = plugin_id
        .chars()
        .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '_' || c == '-');
    if !ok {
        return Err(format!("invalid plugin_id: {plugin_id}"));
    }
    Ok(plugin_id)
}

fn config_path(data_dir: &str, plugin_id: &str) -> Result<PathBuf, String> {
    let id = sanitize_plugin_id(plugin_id)?;
    Ok(config_dir(data_dir).join(format!("{id}.json")))
}

/// Прочитать конфиг плагина. Нет файла → Ok(None): вызывающая сторона (плагин)
/// строит дефолт. Прочие ошибки ввода-вывода пробрасываются.
pub fn load(data_dir: &str, plugin_id: &str) -> Result<Option<String>, String> {
    let path = config_path(data_dir, plugin_id)?;
    match fs::read_to_string(&path) {
        Ok(s) => Ok(Some(s)),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(format!("read plugin config failed: {e}")),
    }
}

/// Записать конфиг плагина атомарно: temp + rename (на Windows std::fs::rename
/// делает MoveFileEx с заменой существующего). Каталог создаётся при первой
/// записи. Временный файл подчищается при сбое rename.
pub fn save(data_dir: &str, plugin_id: &str, contents: &str) -> Result<(), String> {
    let path = config_path(data_dir, plugin_id)?;
    let dir = config_dir(data_dir);
    fs::create_dir_all(&dir).map_err(|e| format!("create config dir failed: {e}"))?;

    let id = sanitize_plugin_id(plugin_id)?;
    let tmp = dir.join(format!(".{}.{}.tmp", id, uuid::Uuid::new_v4()));
    fs::write(&tmp, contents).map_err(|e| format!("write temp config failed: {e}"))?;
    fs::rename(&tmp, &path).map_err(|e| {
        let _ = fs::remove_file(&tmp);
        format!("rename config failed: {e}")
    })?;
    Ok(())
}
