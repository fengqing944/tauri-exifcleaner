!define TAGSWEEP_CONTEXT_MENU_KEY "Software\Classes\AllFileSystemObjects\shell\TagSweep.CleanMetadata"

!macro NSIS_HOOK_POSTINSTALL
  WriteRegStr SHCTX "${TAGSWEEP_CONTEXT_MENU_KEY}" "" "用 TagSweep 清理元数据"
  WriteRegStr SHCTX "${TAGSWEEP_CONTEXT_MENU_KEY}" "Icon" "$INSTDIR\tagsweep.exe,0"
  WriteRegStr SHCTX "${TAGSWEEP_CONTEXT_MENU_KEY}" "MultiSelectModel" "Player"
  WriteRegStr SHCTX "${TAGSWEEP_CONTEXT_MENU_KEY}\command" "" '$\"$INSTDIR\tagsweep.exe$\" --shell-clean $\"%1$\"'
!macroend

!macro NSIS_HOOK_POSTUNINSTALL
  DeleteRegKey SHCTX "${TAGSWEEP_CONTEXT_MENU_KEY}"
!macroend
