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
; Use the names supplied by Tauri so side-by-side test builds are isolated.

!macro NSIS_HOOK_POSTINSTALL
  WriteRegStr HKCU "Software\Classes\Applications\${MAINBINARYNAME}.exe" "FriendlyAppName" "${PRODUCTNAME}"
  WriteRegStr HKCU "Software\Classes\Applications\${MAINBINARYNAME}.exe\DefaultIcon" "" "$\"$INSTDIR\${MAINBINARYNAME}.exe$\",0"
  WriteRegStr HKCU "Software\Classes\Applications\${MAINBINARYNAME}.exe\shell\open\command" "" "$\"$INSTDIR\${MAINBINARYNAME}.exe$\" $\"%1$\""
  ; Advertise the common text formats without selecting a default application.
  !define BN_TYPES "Software\Classes\Applications\${MAINBINARYNAME}.exe\SupportedTypes"
  WriteRegStr HKCU "${BN_TYPES}" ".txt" ""
  WriteRegStr HKCU "${BN_TYPES}" ".md" ""
  WriteRegStr HKCU "${BN_TYPES}" ".log" ""
  WriteRegStr HKCU "${BN_TYPES}" ".json" ""
  WriteRegStr HKCU "${BN_TYPES}" ".jsonl" ""
  WriteRegStr HKCU "${BN_TYPES}" ".xml" ""
  WriteRegStr HKCU "${BN_TYPES}" ".yaml" ""
  WriteRegStr HKCU "${BN_TYPES}" ".yml" ""
  WriteRegStr HKCU "${BN_TYPES}" ".toml" ""
  WriteRegStr HKCU "${BN_TYPES}" ".ini" ""
  WriteRegStr HKCU "${BN_TYPES}" ".csv" ""
  WriteRegStr HKCU "${BN_TYPES}" ".py" ""
  WriteRegStr HKCU "${BN_TYPES}" ".js" ""
  WriteRegStr HKCU "${BN_TYPES}" ".ts" ""
  WriteRegStr HKCU "${BN_TYPES}" ".html" ""
  WriteRegStr HKCU "${BN_TYPES}" ".css" ""
  WriteRegStr HKCU "${BN_TYPES}" ".php" ""
  WriteRegStr HKCU "${BN_TYPES}" ".sql" ""
  WriteRegStr HKCU "${BN_TYPES}" ".properties" ""
  WriteRegStr HKCU "${BN_TYPES}" ".env" ""
  WriteRegStr HKCU "${BN_TYPES}" ".bak" ""
  WriteRegStr HKCU "${BN_TYPES}" ".lock" ""
  WriteRegStr HKCU "${BN_TYPES}" ".hcy" ""
  !undef BN_TYPES
  ; Baseline entry, overwritten by the app on first start.
  WriteRegStr HKCU "Software\Classes\*\shell\${PRODUCTNAME}" "" "Edit with ${PRODUCTNAME}"
  WriteRegStr HKCU "Software\Classes\*\shell\${PRODUCTNAME}" "Icon" "$INSTDIR\${MAINBINARYNAME}.exe,0"
  WriteRegStr HKCU "Software\Classes\*\shell\${PRODUCTNAME}\command" "" "$\"$INSTDIR\${MAINBINARYNAME}.exe$\" $\"%1$\""
  System::Call 'shell32::SHChangeNotify(i 0x08000000, i 0, p 0, p 0)'
!macroend

!macro NSIS_HOOK_PREUNINSTALL
  ; Drop the entry before the executable disappears, so nothing is left in the
  ; context menu pointing at a file that no longer exists.
  ReadRegStr $0 HKCU "Software\Classes\Applications\${MAINBINARYNAME}.exe\shell\open\command" ""
  StrCmp $0 "$\"$INSTDIR\${MAINBINARYNAME}.exe$\" $\"%1$\"" 0 +2
  DeleteRegKey HKCU "Software\Classes\Applications\${MAINBINARYNAME}.exe"
  ReadRegStr $0 HKCU "Software\Classes\*\shell\${PRODUCTNAME}\command" ""
  StrCmp $0 "$\"$INSTDIR\${MAINBINARYNAME}.exe$\" $\"%1$\"" 0 +2
  DeleteRegKey HKCU "Software\Classes\*\shell\${PRODUCTNAME}"
  System::Call 'shell32::SHChangeNotify(i 0x08000000, i 0, p 0, p 0)'
!macroend
