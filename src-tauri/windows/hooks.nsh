; BetterNotepad — extra installer registry steps.
;
; The app maintains the "Edit with BetterNotepad" context-menu entry itself at
; runtime (Settings › General › Explorer context menu). This hook only needs to
; get a baseline entry into place the moment the installer finishes; on the next
; start the app rewrites it with the label in the user's UI language and with
; whatever path it is actually running from.
;
; The label here is deliberately ASCII. NSIS include files are parsed in the
; file's own encoding, and keeping the installer out of the encoding business
; avoids mojibake entirely.
;
; The executable is installed as `notepad-app.exe` — that name comes from the
; Cargo package name, not from `productName`.

!macro NSIS_HOOK_POSTINSTALL
  ; Baseline entry, overwritten by the app on first start.
  WriteRegStr HKCU "Software\Classes\*\shell\BetterNotepad" "" "Edit with BetterNotepad"
  WriteRegStr HKCU "Software\Classes\*\shell\BetterNotepad" "Icon" "$INSTDIR\notepad-app.exe,0"
  WriteRegStr HKCU "Software\Classes\*\shell\BetterNotepad\command" "" "$\"$INSTDIR\notepad-app.exe$\" $\"%1$\""
!macroend

!macro NSIS_HOOK_PREUNINSTALL
  ; Drop the entry before the executable disappears, so nothing is left in the
  ; context menu pointing at a file that no longer exists.
  DeleteRegKey HKCU "Software\Classes\*\shell\BetterNotepad"
!macroend
