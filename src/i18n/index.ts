/**
 * Tiny i18n layer.
 *
 * Deliberately not a library: the UI needs two languages, no pluralisation or
 * date formatting, and `t()` is called from places that cannot use hooks (event
 * callbacks, context-menu item builders). A module-level locale plus a plain
 * function keeps those call sites unchanged.
 *
 * Re-rendering: the locale lives in editor settings (React state owned by App),
 * so changing it re-renders the whole tree. App calls `setI18nLocale()` during
 * render, before any child renders, so descendants always read the fresh value.
 */

export type Locale = "zh" | "en";
/** What the user picks in Settings: an explicit language, or follow the OS. */
export type LocaleSetting = "system" | Locale;

type Dict = Record<string, string>;

const en: Dict = {
  "app.dropToOpen": "Drop files to open",
  "app.showExplorer": "Show Explorer",
  "common.closeEsc": "Close (Esc)",
  "dialog.executable": "Executable",
  "dialog.allFiles": "All Files",
  "dialog.textFiles": "Text Files",
  "editor.placeholder": "Start typing...",
  "resize.title": "Drag to resize",
  "resize.heightTitle": "Drag to resize height",

  "tab.new": "New tab",
  "tab.newTitle": "New tab (Ctrl+N)",
  "tab.close": "Close tab",
  "tab.untitled": "Untitled",

  "toolbar.new": "New",
  "toolbar.open": "Open",
  "toolbar.openFolder": "Open Folder",
  "toolbar.save": "Save",
  "toolbar.saveAll": "Save All",
  "toolbar.saveAs": "Save As",
  "toolbar.find": "Find",
  "toolbar.findFiles": "Search in Folder",
  "toolbar.wrap": "Word Wrap",
  "toolbar.preview": "Preview",
  "toolbar.run": "Run",
  "toolbar.stop": "Stop",
  "toolbar.output": "Output",
  "toolbar.about": "About",
  "toolbar.settings": "Settings",
  "toolbar.theme": "Theme",
  "toolbar.themeLight": "Light",
  "toolbar.themeDark": "Dark",
  "toolbar.themeWarm": "Warm",
  "toolbar.mascot": "Mascot",
  "toolbar.newTitle": "New (Ctrl+N)",
  "toolbar.openTitle": "Open (Ctrl+O)",
  "toolbar.saveTitle": "Save (Ctrl+S)",
  "toolbar.saveAsTitle": "Save As (Ctrl+Shift+S)",
  "toolbar.saveAllTitle": "Save All",
  "toolbar.openFolderTitle": "Open Folder",
  "toolbar.explorerTitle": "Explorer",
  "toolbar.undoTitle": "Undo (Ctrl+Z)",
  "toolbar.redoTitle": "Redo (Ctrl+Y)",
  "toolbar.runTitle": "Run (Ctrl+Enter)",
  "toolbar.stopTitle": "Stop",
  "toolbar.findTitle": "Find (Ctrl+F)",
  "toolbar.zoomOutTitle": "Zoom Out (Ctrl+-)",
  "toolbar.zoomInTitle": "Zoom In (Ctrl+=)",
  "toolbar.wrapOnTitle": "Word Wrap On — click to turn off",
  "toolbar.wrapOffTitle": "Word Wrap Off — click to turn on",
  "toolbar.aboutTitle": "About BetterNotepad",
  "toolbar.settingsTitle": "Settings",
  "toolbar.settingsAria": "Open settings",
  "toolbar.mascotShowTitle": "Show mascot",
  "toolbar.mascotHideTitle": "Hide mascot",
  "toolbar.mascotAria": "Toggle mascot",
  "toolbar.themeAria": "Switch theme",
  "toolbar.themeSwitch": "{theme} — click to switch",
  "theme.light": "Light theme",
  "theme.dark": "Dark theme",
  "theme.warm": "Warm theme",

  "search.placeholder": "Find",
  "search.replacePlaceholder": "Replace with",
  "search.caseSensitive": "Match case",
  "search.regex": "Regular expression",
  "search.regexTitle": "Use regular expression",
  "search.previous": "Previous match",
  "search.prevTitle": "Previous (Shift+Enter)",
  "search.next": "Next match",
  "search.nextTitle": "Next (Enter)",
  "search.replace": "Replace",
  "search.replaceAll": "Replace all",
  "search.all": "All",
  "search.toggleReplace": "Toggle replace",
  "search.close": "Close",
  "search.noResults": "No matches",
  "search.invalidRegex": "Invalid regex",
  "search.replaced": "{count} replaced",
  "search.openFolderFirst": "Open a folder first (Open Folder)",

  "globalSearch.placeholder": "Search in folder",
  "globalSearch.searching": "Searching…",
  "globalSearch.noResults": "No matches",
  "globalSearch.results": "{count} matches in {files} files",
  "globalSearch.close": "Close",

  "output.title": "Output",
  "output.copy": "Copy",
  "output.copied": "Copied",
  "output.copyAll": "Copy All",
  "output.copyAllTitle": "Copy all output",
  "output.selectAll": "Select All",
  "output.clear": "Clear",
  "output.stop": "Stop",
  "output.closeTitle": "Close output",
  "output.none": "No output.",
  "output.empty": "Run a file to see its output here.",
  "output.running": "Running…",
  "output.stopped": "Stopped",
  "output.exited": "exited {code}",
  "output.exitCode": "Exited with code {code}",
  "output.workingDir": "Running in: {dir}",
  "output.inputPlaceholder": "Type a line, press Enter to send…",
  "output.inputIdle": "Run a program to enable input",
  "output.inputTitle": "Enter sends this line to the program (↑/↓ for history)",
  "output.inputIdleTitle": "The program is not running, so it cannot read input",
  "output.send": "Send",
  "output.sendTitle": "Send this line to the program's standard input",

  "run.desktopOnly": "Running files only works in the desktop app.",
  "run.in": "Running in: {dir}",
  "run.inAppDir": "Running in: the app's own directory.",
  "run.hintNoCustom":
    'No custom run directory is set, so the script runs in its own folder. Set one in Settings › Editor › "Run in".',
  "run.hintNoFolder":
    "No folder is open — the script runs in its own folder, so files it writes land next to the script. Use File › Open Folder to pick a working directory first.",
  "run.noRunner": "No runner configured for this file type. Open Settings to add one.",
  "run.noInterpreter": "No interpreter enabled for {lang}. Open Settings to configure it.",

  "status.line": "Ln {line}, Col {col}",
  "status.lines": "{count} lines",
  "status.chars": "{count} chars",
  "status.selected": "{count} selected",
  "status.spaces": "Spaces: {size}",
  "status.tabWidth": "Tab width: {size}",
  "status.highlightOff": "Highlight off",
  "status.encoding": "Encoding",
  "status.eol": "Line ending",
  "status.encodingTitle": "Choose the encoding used when saving this file",
  "status.indentSpaces": "Indent: spaces",
  "status.indentTabs": "Indent: tab characters",
  "status.highlightTitle": "File has too many lines for syntax highlighting",

  "explorer.title": "Explorer",
  "explorer.openFolder": "Open Folder",
  "explorer.noFolder": "No folder opened",
  "explorer.newFile": "New File",
  "explorer.newFolder": "New Folder",
  "explorer.rename": "Rename",
  "explorer.delete": "Delete",
  "explorer.refresh": "Refresh",
  "explorer.revealActive": "Reveal Active File",
  "explorer.closeTitle": "Close explorer",
  "explorer.empty": "Empty folder",
  "explorer.confirmDelete": "Delete “{name}”?",
  "explorer.namePlaceholder": "Name",

  "recent.title": "Recent Files",
  "recent.clear": "Clear list",
  "recent.empty": "No recent files",

  "menu.cut": "Cut",
  "menu.copy": "Copy",
  "menu.paste": "Paste",
  "menu.selectAll": "Select All",
  "menu.undo": "Undo",
  "menu.redo": "Redo",

  "confirm.unsavedTitle": "Unsaved changes",
  "confirm.unsavedBody": "“{name}” has unsaved changes. Save before closing?",
  "confirm.saveChangesTitle": "Save changes?",
  "confirm.unsavedNew": "“{name}” has not been saved yet. Save it before closing?",
  "confirm.unsavedModified": "“{name}” has unsaved changes. Save them before closing?",
  "confirm.save": "Save",
  "confirm.discard": "Don't Save",
  "confirm.cancel": "Cancel",
  "confirm.closeAppTitle": "Unsaved changes",
  "confirm.closeAppAskTitle": "Save changes before closing?",
  "confirm.unsavedLead": "The following tabs have unsaved changes:",
  "confirm.closeAppBody": "{count} file(s) have unsaved changes. Save all before quitting?",
  "confirm.saveAll": "Save All",
  "confirm.discardAll": "Don't Save",

  "settings.title": "Settings",
  "settings.tab.editor": "Editor",
  "settings.tab.interpreters": "Interpreters",
  "settings.tab.general": "General",
  "settings.done": "Done",
  "settings.detect": "Detect",
  "settings.language": "Language",
  "settings.language.system": "System",
  "settings.language.zh": "简体中文",
  "settings.language.en": "English",
  "settings.contextMenu": "Explorer context menu",
  "settings.contextMenu.hint":
    "Adds an “Edit with BetterNotepad” entry to the right-click menu of every file. On Windows 11 it sits under “Show more options” — the first-level menu only accepts MSIX-packaged apps.",
  "shell.editWith": "Edit with BetterNotepad",

  "settings.tabWidth": "Tab width",
  "settings.insert": "Insert",
  "settings.insert.spaces": "Spaces",
  "settings.insert.tab": "Tab",
  "settings.defaultEol": "Default line ending",
  "settings.font": "Font",
  "settings.fontSize": "Font size",
  "settings.bracketMatching": "Highlight matching brackets",
  "settings.bracketMatching.hint":
    "When the caret sits next to a bracket, that bracket and its counterpart are highlighted together. Unmatched brackets are marked in red.",
  "settings.runIn": "Run in",
  "settings.runIn.folder": "Open folder",
  "settings.runIn.script": "Script folder",
  "settings.runIn.custom": "Custom",
  "settings.runIn.customPlaceholder": "Working directory for run programmes",
  "settings.runIn.browse": "Browse for directory",
  "settings.runIn.hintLead": "Working directory handed to scripts you run, so relative paths like ",
  "settings.runIn.hintTail":
    " resolve predictably. Falls back to the script's own folder when the chosen directory is unavailable.",

  "settings.interpreters.hint":
    "Interpreters are auto-detected from your system PATH. Enable the languages you want to run; use the folder button to pick an executable for any that weren't found.",
  "settings.interpreters.empty": "No interpreters yet — click “Detect” to auto-detect.",
  "settings.interpreters.enable": "Enable {language}",
  "settings.interpreters.browse": "Browse for executable",
  "settings.interpreters.command": "Command",

  "about.version": "Version",
  "about.updates": "Updates",
  "about.check": "Check for updates",
  "about.checkHint":
    "Opens the project's GitHub page in your browser, where every release and its notes are listed.",
  "about.unknownVersion": "unknown",

  "about.tagline": "Modern desktop notepad · lightweight code editor",
  "about.tagline2":
    "Covers most of what Windows Notepad and Notepad++ do, in a much nicer interface.",
  "about.feature1": "Syntax highlighting for 30+ languages, picked by file extension",
  "about.feature2": "Multi-tab with drag reordering, session recovery after a crash",
  "about.feature3": "Split-view live Markdown preview, regex find and replace",
  "about.feature4": "Run code with built-in interpreters, output panel",
  "about.feature5": "Three themes · 3D mascot",
  "about.close": "Close",
  "about.homepage": "Open project homepage in browser",

  "mascot.click1": "Hehe~",
  "mascot.click2": "Stop poking me~",
  "mascot.click3": "Hee hee",
  "mascot.click4": "That tickles~",
  "mascot.click5": "Keep going, you've got this~",
  "mascot.typing1": "Go go go!",
  "mascot.typing2": "Nice work~",
  "mascot.typing3": "Clear thinking!",
  "mascot.typing4": "I'm watching you~",
  "mascot.typing5": "Take a break?",
  "mascot.typing6": "Good job today~",
  "mascot.typing7": "Keep charging ahead~",
  "mascot.typing8": "That logic is elegant!",
};

const zh: Dict = {
  "app.dropToOpen": "松开以打开文件",
  "app.showExplorer": "显示资源管理器",
  "common.closeEsc": "关闭（Esc）",
  "dialog.executable": "可执行文件",
  "dialog.allFiles": "所有文件",
  "dialog.textFiles": "文本文件",
  "editor.placeholder": "开始输入…",
  "resize.title": "拖动调整宽度",
  "resize.heightTitle": "拖动调整高度",

  "tab.new": "新建标签",
  "tab.newTitle": "新建标签（Ctrl+N）",
  "tab.close": "关闭标签",
  "tab.untitled": "未命名",

  "toolbar.new": "新建",
  "toolbar.open": "打开",
  "toolbar.openFolder": "打开文件夹",
  "toolbar.save": "保存",
  "toolbar.saveAll": "全部保存",
  "toolbar.saveAs": "另存为",
  "toolbar.find": "查找",
  "toolbar.findFiles": "在文件夹中搜索",
  "toolbar.wrap": "自动换行",
  "toolbar.preview": "预览",
  "toolbar.run": "运行",
  "toolbar.stop": "停止",
  "toolbar.output": "输出",
  "toolbar.about": "关于",
  "toolbar.settings": "设置",
  "toolbar.theme": "主题",
  "toolbar.themeLight": "浅色",
  "toolbar.themeDark": "深色",
  "toolbar.themeWarm": "暖色",
  "toolbar.mascot": "看板娘",
  "toolbar.newTitle": "新建（Ctrl+N）",
  "toolbar.openTitle": "打开（Ctrl+O）",
  "toolbar.saveTitle": "保存（Ctrl+S）",
  "toolbar.saveAsTitle": "另存为（Ctrl+Shift+S）",
  "toolbar.saveAllTitle": "全部保存",
  "toolbar.openFolderTitle": "打开文件夹",
  "toolbar.explorerTitle": "资源管理器",
  "toolbar.undoTitle": "撤销（Ctrl+Z）",
  "toolbar.redoTitle": "重做（Ctrl+Y）",
  "toolbar.runTitle": "运行（Ctrl+Enter）",
  "toolbar.stopTitle": "停止",
  "toolbar.findTitle": "查找（Ctrl+F）",
  "toolbar.zoomOutTitle": "缩小（Ctrl+-）",
  "toolbar.zoomInTitle": "放大（Ctrl+=）",
  "toolbar.wrapOnTitle": "自动换行已开启 —— 点击关闭",
  "toolbar.wrapOffTitle": "自动换行已关闭 —— 点击开启",
  "toolbar.aboutTitle": "关于 BetterNotepad",
  "toolbar.settingsTitle": "设置",
  "toolbar.settingsAria": "打开设置",
  "toolbar.mascotShowTitle": "显示看板娘",
  "toolbar.mascotHideTitle": "隐藏看板娘",
  "toolbar.mascotAria": "切换看板娘",
  "toolbar.themeAria": "切换主题",
  "toolbar.themeSwitch": "{theme} —— 点击切换",
  "theme.light": "浅色主题",
  "theme.dark": "深色主题",
  "theme.warm": "暖色主题",

  "search.placeholder": "查找",
  "search.replacePlaceholder": "替换为",
  "search.caseSensitive": "区分大小写",
  "search.regex": "正则表达式",
  "search.regexTitle": "使用正则表达式",
  "search.previous": "上一个匹配",
  "search.prevTitle": "上一个（Shift+Enter）",
  "search.next": "下一个匹配",
  "search.nextTitle": "下一个（Enter）",
  "search.replace": "替换",
  "search.replaceAll": "全部替换",
  "search.all": "全部",
  "search.toggleReplace": "切换替换栏",
  "search.close": "关闭",
  "search.noResults": "无匹配项",
  "search.invalidRegex": "正则表达式无效",
  "search.replaced": "已替换 {count} 处",
  "search.openFolderFirst": "请先打开文件夹（打开文件夹）",

  "globalSearch.placeholder": "在文件夹中搜索",
  "globalSearch.searching": "搜索中…",
  "globalSearch.noResults": "无匹配项",
  "globalSearch.results": "{files} 个文件中有 {count} 处匹配",
  "globalSearch.close": "关闭",

  "output.title": "输出",
  "output.copy": "复制",
  "output.copied": "已复制",
  "output.copyAll": "复制全部",
  "output.copyAllTitle": "复制全部输出",
  "output.selectAll": "全选",
  "output.clear": "清空",
  "output.stop": "停止",
  "output.closeTitle": "关闭输出",
  "output.none": "暂无输出。",
  "output.empty": "运行文件后，输出会显示在这里。",
  "output.running": "运行中…",
  "output.stopped": "已停止",
  "output.exited": "已退出（{code}）",
  "output.exitCode": "退出码 {code}",
  "output.workingDir": "运行目录：{dir}",
  "output.inputPlaceholder": "输入一行内容，按回车发送…",
  "output.inputIdle": "运行程序后即可输入",
  "output.inputTitle": "回车把这一行发送给程序（↑/↓ 翻历史）",
  "output.inputIdleTitle": "程序未在运行，无法读取输入",
  "output.send": "发送",
  "output.sendTitle": "把这一行发送到程序的标准输入",

  "run.desktopOnly": "运行功能仅在桌面版应用中可用。",
  "run.in": "运行目录：{dir}",
  "run.inAppDir": "运行目录：应用自身所在目录。",
  "run.hintNoCustom":
    "未设置自定义运行目录，脚本将在自身所在目录中运行。可在「设置 › 编辑器 › 运行目录」中设置。",
  "run.hintNoFolder":
    "未打开文件夹 —— 脚本将在自身所在目录中运行，写入的文件会落在脚本旁边。请先用「文件 › 打开文件夹」选择工作目录。",
  "run.noRunner": "此文件类型尚未配置运行器，请在设置中添加。",
  "run.noInterpreter": "未启用 {lang} 解释器，请在设置中配置。",

  "status.line": "第 {line} 行，第 {col} 列",
  "status.lines": "{count} 行",
  "status.chars": "{count} 字符",
  "status.selected": "已选 {count} 字符",
  "status.spaces": "空格：{size}",
  "status.tabWidth": "Tab 宽度：{size}",
  "status.highlightOff": "高亮已关闭",
  "status.encoding": "编码",
  "status.eol": "行尾",
  "status.encodingTitle": "选择保存此文件时使用的编码",
  "status.indentSpaces": "缩进：空格",
  "status.indentTabs": "缩进：Tab 字符",
  "status.highlightTitle": "文件行数过多，已关闭语法高亮",

  "explorer.title": "资源管理器",
  "explorer.openFolder": "打开文件夹",
  "explorer.noFolder": "未打开文件夹",
  "explorer.newFile": "新建文件",
  "explorer.newFolder": "新建文件夹",
  "explorer.rename": "重命名",
  "explorer.delete": "删除",
  "explorer.refresh": "刷新",
  "explorer.revealActive": "定位当前文件",
  "explorer.closeTitle": "关闭资源管理器",
  "explorer.empty": "空文件夹",
  "explorer.confirmDelete": "确定删除「{name}」？",
  "explorer.namePlaceholder": "名称",

  "recent.title": "最近文件",
  "recent.clear": "清空列表",
  "recent.empty": "暂无最近文件",

  "menu.cut": "剪切",
  "menu.copy": "复制",
  "menu.paste": "粘贴",
  "menu.selectAll": "全选",
  "menu.undo": "撤销",
  "menu.redo": "重做",

  "confirm.unsavedTitle": "有未保存的更改",
  "confirm.unsavedBody": "「{name}」有未保存的更改，关闭前要保存吗？",
  "confirm.saveChangesTitle": "要保存更改吗？",
  "confirm.unsavedNew": "「{name}」尚未保存，关闭前要保存吗？",
  "confirm.unsavedModified": "「{name}」有未保存的更改，关闭前要保存吗？",
  "confirm.save": "保存",
  "confirm.discard": "不保存",
  "confirm.cancel": "取消",
  "confirm.closeAppTitle": "有未保存的更改",
  "confirm.closeAppAskTitle": "关闭前要保存更改吗？",
  "confirm.unsavedLead": "以下标签页有未保存的更改：",
  "confirm.closeAppBody": "有 {count} 个文件未保存，退出前要全部保存吗？",
  "confirm.saveAll": "全部保存",
  "confirm.discardAll": "全部不保存",

  "settings.title": "设置",
  "settings.tab.editor": "编辑器",
  "settings.tab.interpreters": "解释器",
  "settings.tab.general": "通用",
  "settings.done": "完成",
  "settings.detect": "自动检测",
  "settings.language": "语言",
  "settings.language.system": "跟随系统",
  "settings.language.zh": "简体中文",
  "settings.language.en": "English",
  "settings.contextMenu": "资源管理器右键菜单",
  "settings.contextMenu.hint":
    "在所有文件的右键菜单里加一项「以 BetterNotepad 编辑」。Windows 11 上它位于「显示更多选项」之中 —— 一级菜单只接受 MSIX 打包的应用。",
  "shell.editWith": "以 BetterNotepad 编辑",

  "settings.tabWidth": "Tab 宽度",
  "settings.insert": "按 Tab 插入",
  "settings.insert.spaces": "空格",
  "settings.insert.tab": "Tab 字符",
  "settings.defaultEol": "默认行尾",
  "settings.font": "字体",
  "settings.fontSize": "字号",
  "settings.bracketMatching": "高亮匹配的括号",
  "settings.bracketMatching.hint":
    "光标停在括号旁边时，这个括号和与之配对的那个会一起高亮。找不到配对的括号会用红色标出。",
  "settings.runIn": "运行目录",
  "settings.runIn.folder": "打开文件夹",
  "settings.runIn.script": "脚本所在目录",
  "settings.runIn.custom": "自定义目录",
  "settings.runIn.customPlaceholder": "运行程序时使用的工作目录",
  "settings.runIn.browse": "选择目录",
  "settings.runIn.hintLead": "运行脚本时使用的工作目录，让 ",
  "settings.runIn.hintTail": " 这类相对路径有确定的解析位置。若所选目录不可用，会回退到脚本自身所在目录。",

  "settings.interpreters.hint":
    "解释器从系统 PATH 自动检测。勾选你要运行的语言；没检测到的可以点文件夹按钮手动指定可执行文件。",
  "settings.interpreters.empty": "还没有解释器 —— 点「自动检测」试试。",
  "settings.interpreters.enable": "启用 {language}",
  "settings.interpreters.browse": "选择可执行文件",
  "settings.interpreters.command": "命令",

  "about.version": "版本",
  "about.updates": "更新",
  "about.check": "检查更新",
  "about.checkHint": "将在浏览器中打开项目的 GitHub 页面，可查看每个版本的更新说明。",
  "about.unknownVersion": "未知",

  "about.tagline": "现代化桌面记事本 · 轻量代码编辑器",
  "about.tagline2": "涵盖系统记事本与 Notepad++ 的绝大部分功能，且界面更美观舒适。",
  "about.feature1": "30+ 语言语法高亮，按扩展名自动识别",
  "about.feature2": "多标签 + 拖拽排序，崩溃自动恢复",
  "about.feature3": "Markdown 分栏实时预览，正则查找替换",
  "about.feature4": "内置解释器运行代码 + 输出面板",
  "about.feature5": "三套主题 · 3D 看板娘",
  "about.close": "关闭",
  "about.homepage": "在浏览器中打开项目主页",

  "mascot.click1": "嘿嘿~",
  "mascot.click2": "别戳我啦~",
  "mascot.click3": "嘻嘻",
  "mascot.click4": "痒痒的~",
  "mascot.click5": "要继续加油哦~",
  "mascot.typing1": "加油!",
  "mascot.typing2": "写得不错~",
  "mascot.typing3": "思路很清晰!",
  "mascot.typing4": "我盯着你呢~",
  "mascot.typing5": "休息一下?",
  "mascot.typing6": "今天也辛苦啦~",
  "mascot.typing7": "继续冲鸭~",
  "mascot.typing8": "这段逻辑很漂亮!",
};

const DICTIONARIES: Record<Locale, Dict> = { en, zh };

let currentLocale: Locale = "zh";

export function setI18nLocale(locale: Locale): void {
  currentLocale = locale;
}

export function getI18nLocale(): Locale {
  return currentLocale;
}

/** "system" resolves against the OS/browser languages, defaulting to Chinese. */
export function resolveLocale(setting: LocaleSetting): Locale {
  if (setting === "zh" || setting === "en") return setting;
  const tags =
    typeof navigator !== "undefined" && navigator.languages?.length
      ? navigator.languages
      : [typeof navigator !== "undefined" ? navigator.language : "zh"];
  for (const tag of tags) {
    const low = (tag ?? "").toLowerCase();
    if (low.startsWith("zh")) return "zh";
    if (low.startsWith("en")) return "en";
  }
  return "zh";
}

/**
 * Translates a key. Missing keys fall back to English and then to the key
 * itself, so a typo shows up as visible text instead of an empty string.
 * `{name}` placeholders are replaced from `vars`.
 */
export function t(key: string, vars?: Record<string, string | number>): string {
  const dict = DICTIONARIES[currentLocale];
  const template = dict[key] ?? DICTIONARIES.en[key] ?? key;
  if (!vars) return template;
  return template.replace(/\{(\w+)\}/g, (match, name: string) =>
    name in vars ? String(vars[name]) : match
  );
}

/** Every key defined in the dictionary — used by the key-coverage check. */
export function allKeys(): string[] {
  return Object.keys(en);
}
