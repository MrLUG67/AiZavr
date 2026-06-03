use sqlx::{sqlite::SqlitePoolOptions, SqlitePool};
use std::fs;

pub async fn init_db(app_data_dir: &str) -> Result<SqlitePool, sqlx::Error> {
    // Ensure data directory exists
    fs::create_dir_all(app_data_dir).ok();

    let db_path = format!("{}/aizavr.db", app_data_dir);
    let db_url = format!("sqlite://{}?mode=rwc", db_path);

    let pool = SqlitePoolOptions::new()
        .max_connections(5)
        .connect(&db_url)
        .await?;

    // Run migrations
    sqlx::migrate!("./migrations")
        .run(&pool)
        .await
        .expect("failed to run migrations");

    Ok(pool)
}