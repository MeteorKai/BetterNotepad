use std::fs::{self, File};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Manager};

const MAX_SESSION_BYTES: u64 = 128 * 1024 * 1024;
const SESSION_TOO_LARGE: &str = "SESSION_TOO_LARGE";

fn session_path(app: &AppHandle) -> Result<PathBuf, String> {
    app.path().app_local_data_dir().map(|dir| dir.join("session.json"))
        .map_err(|err| format!("Could not locate session backup: {err}"))
}

fn read_session(path: &Path) -> std::io::Result<Option<String>> {
    let file = match File::open(path) {
        Ok(file) => file,
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(err) => return Err(err),
    };
    if file.metadata()?.len() > MAX_SESSION_BYTES {
        return Err(std::io::Error::new(std::io::ErrorKind::InvalidData, SESSION_TOO_LARGE));
    }
    let mut contents = String::new();
    file.take(MAX_SESSION_BYTES + 1).read_to_string(&mut contents)?;
    if contents.len() as u64 > MAX_SESSION_BYTES {
        return Err(std::io::Error::new(std::io::ErrorKind::InvalidData, SESSION_TOO_LARGE));
    }
    Ok(Some(contents))
}

fn write_session(path: &Path, contents: &str) -> std::io::Result<()> {
    if contents.len() as u64 > MAX_SESSION_BYTES {
        return Err(std::io::Error::new(std::io::ErrorKind::InvalidInput, SESSION_TOO_LARGE));
    }
    let parent = path.parent().expect("session path has a parent");
    fs::create_dir_all(parent)?;
    let mut pending = tempfile::Builder::new().prefix(".session-").tempfile_in(parent)?;
    pending.write_all(contents.as_bytes())?;
    pending.as_file().sync_all()?;
    pending.persist(path)?;
    Ok(())
}

#[tauri::command]
pub async fn load_session_backup(app: AppHandle) -> Result<Option<String>, String> {
    let path = session_path(&app)?;
    tauri::async_runtime::spawn_blocking(move || read_session(&path))
        .await.map_err(|err| err.to_string())?.map_err(|err| err.to_string())
}

#[tauri::command]
pub async fn save_session_backup(app: AppHandle, contents: String) -> Result<(), String> {
    let path = session_path(&app)?;
    tauri::async_runtime::spawn_blocking(move || write_session(&path, &contents))
        .await.map_err(|err| err.to_string())?.map_err(|err| err.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn restores_large_drafts_and_replaces_the_snapshot() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("app").join("session.json");
        assert_eq!(read_session(&path).unwrap(), None);
        let draft = "你好".repeat(1_000_000);
        write_session(&path, &draft).unwrap();
        assert_eq!(read_session(&path).unwrap().as_deref(), Some(draft.as_str()));
        write_session(&path, "[]").unwrap();
        assert_eq!(read_session(&path).unwrap().as_deref(), Some("[]"));
    }

    #[test]
    fn failed_replace_does_not_remove_existing_content_or_leave_staging_files() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("session.json");
        fs::create_dir(&path).unwrap();
        fs::write(path.join("marker"), "keep").unwrap();
        assert!(write_session(&path, "replacement").is_err());
        assert_eq!(fs::read_to_string(path.join("marker")).unwrap(), "keep");
        assert_eq!(fs::read_dir(temp.path()).unwrap().count(), 1);
    }
}
