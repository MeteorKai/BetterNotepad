/// Only update registered NSIS installations, never a loose development EXE.
#[tauri::command]
pub fn update_installation_supported(app: tauri::AppHandle) -> bool {
    #[cfg(windows)]
    {
        use winreg::enums::{HKEY_CURRENT_USER, HKEY_LOCAL_MACHINE, KEY_READ, KEY_WOW64_64KEY};
        use winreg::RegKey;

        let Ok(exe) = std::env::current_exe().and_then(std::fs::canonicalize) else {
            return false;
        };
        let Some(product) = &app.config().product_name else {
            return false;
        };
        let Some(binary) = exe.file_name() else {
            return false;
        };
        let key = format!(r"Software\Microsoft\Windows\CurrentVersion\Uninstall\{product}");
        for hive in [HKEY_CURRENT_USER, HKEY_LOCAL_MACHINE] {
            let Ok(registry) =
                RegKey::predef(hive).open_subkey_with_flags(&key, KEY_READ | KEY_WOW64_64KEY)
            else {
                continue;
            };
            let Ok(location) = registry.get_value::<String, _>("InstallLocation") else {
                continue;
            };
            let installed =
                std::path::Path::new(location.trim_matches('"')).join(binary);
            if let Ok(installed) = std::fs::canonicalize(installed) {
                if installed == exe {
                    return true;
                }
            }
        }
    }
    let _ = app;
    false
}
