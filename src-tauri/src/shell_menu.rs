//! Explorer context-menu integration — the "Edit with BetterNotepad" entry.
//!
//! The entry is nothing more than a registry verb:
//!
//! ```text
//! HKCU\Software\Classes\*\shell\BetterNotepad        (default) = <label>
//!                                                    Icon      = <exe>,0
//! HKCU\Software\Classes\*\shell\BetterNotepad\command (default) = "<exe>" "%1"
//! ```
//!
//! Two deliberate choices:
//!
//! * **HKCU, not HKLM.** Per-user means no administrator prompt and no
//!   elevation during install, and deleting our own key is a complete
//!   uninstall. Nothing machine-wide is touched.
//! * **`*`, not `.txt`.** The app is a general text editor, so the entry is
//!   useful on any file.
//!
//! Windows 11 note: the first-level (compact) context menu only hosts
//! `IExplorerCommand` handlers that ship with an MSIX / sparse-package
//! identity. A registry verb therefore appears under "Show more options"
//! (Shift+F10), exactly like the entries from Notepad++ and 7-Zip. That is a
//! shell policy, not something a registry writer can work around.
//!
//! Both paths below are relative to `HKEY_CURRENT_USER`. The `*` is a literal
//! key name — the Win32 registry API takes key names verbatim, so unlike a
//! PowerShell path it must *not* be escaped.

const VERB: &str = r"Software\Classes\*\shell\BetterNotepad";
const VERB_COMMAND: &str = r"Software\Classes\*\shell\BetterNotepad\command";

#[cfg(windows)]
mod registry {
    use std::io::ErrorKind;
    use std::path::Path;
    use winreg::enums::HKEY_CURRENT_USER;
    use winreg::RegKey;

    use super::{VERB, VERB_COMMAND};

    /// Registered command line, or `None` when the verb is absent.
    pub fn command() -> Option<String> {
        RegKey::predef(HKEY_CURRENT_USER)
            .open_subkey(VERB_COMMAND)
            .ok()
            .and_then(|key| key.get_value::<String, _>("").ok())
            .filter(|value| !value.trim().is_empty())
    }

    pub fn is_enabled() -> bool {
        command().is_some()
    }

    pub fn enable(label: &str, exe: &Path) -> Result<(), String> {
        let root = RegKey::predef(HKEY_CURRENT_USER);
        let exe = exe.to_string_lossy().to_string();

        // The verb key first, so a failure never leaves a command without its
        // label (which would show up in the menu as an odd blank entry).
        let (verb, _) = root
            .create_subkey(VERB)
            .map_err(|e| format!("cannot create {VERB}: {e}"))?;
        verb.set_value("", &label.to_string())
            .map_err(|e| format!("cannot write the menu label: {e}"))?;
        // `,0` picks the first icon in the executable's resource table.
        verb.set_value("Icon", &format!("{exe},0"))
            .map_err(|e| format!("cannot write the menu icon: {e}"))?;

        let (command, _) = root
            .create_subkey(VERB_COMMAND)
            .map_err(|e| format!("cannot create {VERB_COMMAND}: {e}"))?;
        // %1 is the selected file. Quoting both sides keeps paths containing
        // spaces intact when Explorer builds the command line.
        command
            .set_value("", &format!("\"{exe}\" \"%1\""))
            .map_err(|e| format!("cannot write the menu command: {e}"))?;

        Ok(())
    }

    pub fn disable() -> Result<(), String> {
        // `delete_subkey_all` takes the whole subtree, so `command` goes with
        // it. The empty `*\shell` key it leaves behind is harmless and shared
        // by convention with every other editor that does the same.
        match RegKey::predef(HKEY_CURRENT_USER).delete_subkey_all(VERB) {
            Ok(()) => Ok(()),
            Err(e) if e.kind() == ErrorKind::NotFound => Ok(()),
            Err(e) => Err(format!("cannot remove {VERB}: {e}")),
        }
    }
}

#[cfg(not(windows))]
mod registry {
    use std::path::Path;

    pub fn command() -> Option<String> {
        None
    }
    pub fn is_enabled() -> bool {
        false
    }
    pub fn enable(_label: &str, _exe: &Path) -> Result<(), String> {
        Err("The Explorer context menu is only available on Windows".into())
    }
    pub fn disable() -> Result<(), String> {
        Ok(())
    }
}

/// Is the entry currently registered?
#[tauri::command]
pub fn context_menu_enabled() -> bool {
    registry::is_enabled()
}

/// The command line currently registered, so the settings UI can show it.
#[tauri::command]
pub fn context_menu_command() -> Option<String> {
    registry::command()
}

/// Add or remove the entry.
///
/// `label` comes from the frontend so the menu wording follows the UI language.
/// The frontend calls this on every start while the setting is on, which also
/// repairs the recorded path if the executable has moved since.
#[tauri::command]
pub fn set_context_menu(enabled: bool, label: String) -> Result<(), String> {
    if !enabled {
        return registry::disable();
    }

    let exe = std::env::current_exe()
        .map_err(|e| format!("cannot locate the running executable: {e}"))?;
    registry::enable(&label, &exe)
}
