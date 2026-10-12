/// Only update registered NSIS installations, never a loose development EXE.
#[tauri::command]
pub fn update_installation_supported() -> bool {
    #[cfg(windows)]
    {
        use winreg::enums::{HKEY_CURRENT_USER, HKEY_LOCAL_MACHINE, KEY_READ, KEY_WOW64_64KEY};
        use winreg::RegKey;

        let Ok(exe) = std::env::current_exe().and_then(std::fs::canonicalize) else {
            return false;
        };
        let key = r"Software\Microsoft\Windows\CurrentVersion\Uninstall\BetterNotepad";
        for hive in [HKEY_CURRENT_USER, HKEY_LOCAL_MACHINE] {
            let Ok(registry) =
                RegKey::predef(hive).open_subkey_with_flags(key, KEY_READ | KEY_WOW64_64KEY)
            else {
                continue;
            };
            let Ok(location) = registry.get_value::<String, _>("InstallLocation") else {
                continue;
            };
            let installed =
                std::path::Path::new(location.trim_matches('"')).join("notepad-app.exe");
            if let Ok(installed) = std::fs::canonicalize(installed) {
                if installed == exe {
                    return true;
                }
            }
        }
    }
    false
}
