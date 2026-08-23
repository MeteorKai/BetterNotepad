# BetterNotepad

一个基于 **Tauri 2** 的现代化桌面记事本，同时是一把趁手的轻量代码编辑器。

总而言之：**涵盖系统记事本和 Notepad++ 的绝大部分功能，且界面更为美观舒适。**

Windows 安装包即装即用，无需任何配置。



# Show Time

![image-20260823134700780](C:\Users\TY\AppData\Roaming\Typora\typora-user-images\image-20260823134700780.png)

![image-20260823134709598](C:\Users\TY\AppData\Roaming\Typora\typora-user-images\image-20260823134709598.png)

![image-20260823134718558](C:\Users\TY\AppData\Roaming\Typora\typora-user-images\image-20260823134718558.png)

![image-20260823134737415](C:\Users\TY\AppData\Roaming\Typora\typora-user-images\image-20260823134737415.png)

![image-20260823134810742](C:\Users\TY\AppData\Roaming\Typora\typora-user-images\image-20260823134810742.png)

![image-20260823134932220](C:\Users\TY\AppData\Roaming\Typora\typora-user-images\image-20260823134932220.png)





---

## 为什么选择 BetterNotepad？

| 能力 | 系统记事本 | Notepad++ | **BetterNotepad** |
|---|---|---|---|
| 界面 | 简陋 | 老式 | 现代美观，三套主题（Light / Dark / Warm） |
| 多标签 | ✗ | ✓ | ✓ 支持**拖拽排序**、双击重命名 |
| 语法高亮 | ✗ | ✓ | ✓ 30+ 种语言，按扩展名自动识别 |
| 正则查找 / 替换 | ✗ | ✓ | ✓ 支持模式匹配与 `$1` 捕获组替换 |
| 编码识别 | 部分 | ✓ | ✓ UTF-8 / GBK / UTF-16 自动探测，可转换 |
| 崩溃恢复 | ✗ | 部分 | ✓ 自动恢复未保存的内容 |
| Markdown 实时预览 | ✗ | ✗ | ✓ 分栏实时预览，带代码高亮 |
| 直接运行代码 | ✗ | 需插件 | ✓ 内置解释器运行 + 输出面板 |
| 跨文件搜索 | ✗ | ✓ | ✓ 一键搜索整个文件夹 |
| 文件管理 | ✗ | 需插件 | ✓ 内置文件树，新建/重命名/删除 |
| 行尾 / 编码切换 | ✗ | ✓ | ✓ LF / CRLF，混合行尾自动修复 |
| 3D 看板娘 | ✗ | ✗ | ✓ 可拖拽互动的可爱看板娘 |

**一句话**：打开即用、界面现代、功能完整的记事本 + 轻量 IDE 合体。

---

## 下载与安装

从 **[Releases](../../releases)** 下载最新安装包：

- `BetterNotepad_0.1.0_x64-setup.exe`

双击安装即可。安装后 `.txt` 文件默认关联到 BetterNotepad（若未自动关联，右键文件 → 打开方式 → 选择 BetterNotepad → 始终）。

---

## 功能一览

### 编辑体验
- **实时语法高亮**：Python / PHP / JS / TS / JSX / Rust / Go / Java / C / C++ / C# / Kotlin / CSS / SCSS / JSON / Markdown / YAML / TOML / Bash / SQL / Ruby / Swift / INI / Docker / Diff 等
- **智能输入**：括号/引号自动配对、自动缩进、`}` 自动缩进、`Ctrl+/` 行注释切换
- **撤销 / 重做**：跨标签各自保留历史，切换标签不丢
- **大文件保护**：超过 1 万行自动关闭高亮，保证输入流畅
- 行号栏、可选 Word Wrap

### 查找与替换
- `Ctrl+F` 即时高亮全部匹配，循环上一个/下一个
- 大小写开关
- **正则模式**：输入 `\d+`、`TODO.*` 等模式；替换支持 `$1` 捕获组
- 非法正则实时提示

### 文件与标签
- 多标签 + **拖拽排序** + 双击重命名
- 新建 / 打开 / 保存 / 另存为 / **保存全部**
- **会话恢复**：关闭或崩溃后自动恢复未保存内容
- 最近文件列表
- 编码选择：UTF-8 / UTF-8 BOM / GBK / UTF-16 LE / UTF-16 BE
- 行尾：自动识别 LF / CRLF，新建文件可选默认，混合行尾保存时自动统一
- 拖拽打开文件、"打开方式"打开文件

### 文件管理
- 侧边栏文件树：新建文件/文件夹、重命名、删除、自动定位当前文件
- **跨文件搜索**（`Ctrl+Shift+F`）：递归搜索整个文件夹，点击结果跳转

### 运行代码
- 内置解释器运行器：Python / PHP / Node / Ruby / Go / Bash / Perl 等
- 自动检测 PATH，或手动指定解释器路径
- 底部输出面板：实时输出、退出码、一键停止

### 其他
- Markdown **实时预览**（带代码高亮，可分栏调比例）
- 三套主题一键切换并记住
- 3D 看板娘：可拖拽、点击互动、打字鼓励

---

## 使用说明

### 快捷键

| 快捷键 | 功能 |
|---|---|
| `Ctrl+N` / `Ctrl+O` | 新建 / 打开文件 |
| `Ctrl+S` / `Ctrl+Shift+S` | 保存 / 另存为 |
| `Ctrl+F` / `Ctrl+H` | 查找 / 查找并替换 |
| `Ctrl+Shift+F` | 跨文件搜索 |
| `Enter` / `Shift+Enter`（查找框内） | 下一个 / 上一个匹配 |
| `F3` / `Shift+F3` | 下一个 / 上一个匹配 |
| `Ctrl+W` | 关闭当前标签 |
| `Ctrl+Tab` / `Ctrl+Shift+Tab` | 循环切换标签 |
| `Ctrl+PageUp` / `Ctrl+PageDown` | 循环切换标签 |
| `Ctrl+Enter` | 运行当前文件 |
| `Ctrl+/` | 行注释切换 |
| `Ctrl+Z` / `Ctrl+Y` / `Ctrl+Shift+Z` | 撤销 / 重做 |
| `Ctrl+=` / `Ctrl+-` / `Ctrl+0` | 放大 / 缩小 / 重置字号 |
| `Esc` | 关闭查找 / 弹窗 |

### 编辑器设置
点击工具栏 **齿轮** → **Editor** 页签：

- **Tab 宽度**（1–8）
- **按 Tab 插入**：空格 或 真 Tab 字符
- **默认行尾**：LF / CRLF
- **字体**：内置多种等宽字体族（Consolas / Cascadia Code / JetBrains Mono / Fira Code / 微软雅黑…）
- **字号**（8–32，与 `Ctrl+=/-` 联动）

### 正则查找示例

打开查找（`Ctrl+F`）→ 点 `.*` 开关：

| 想做什么 | 查找 | 替换为 |
|---|---|---|
| 匹配所有数字 | `\d+` | — |
| 匹配以 TODO 开头的行 | `TODO.*` | — |
| 交换键值 | `(name=)(\w+)` | `$2=$1` |
| 批量加引号 | `(\w+)=(\w+)` | `$1="$2"` |

### 编码与行尾
- 状态栏右侧显示当前编码，点击切换（下次保存即按新编码写入）
- 打开 UTF-16 / GBK 文件自动识别
- 状态栏显示当前缩进设置（`Spaces: N` / `Tab width: N`）

### 运行代码
1. 工具栏 → 设置 → **Interpreters**，勾选并确认解释器路径（可自动检测）
2. 打开对应语言文件，`Ctrl+Enter` 运行
3. 底部面板查看输出，`Stop` 终止

---

## 常见问题

**打开大文件很卡？**
超过 1 万行会自动关闭语法高亮（状态栏显示 "Highlight off"），保证正常输入。

**`.txt` 双击没有用 BetterNotepad 打开？**
Windows 11 的默认应用由系统"打开方式"决定：右键文件 → 打开方式 → 始终使用 BetterNotepad。

**已保存的未保存内容会丢吗？**
不会。BetterNotepad 会自动恢复上次关闭/崩溃时的未保存内容。

---

## 技术栈

Tauri 2 · React 19 · TypeScript · Tailwind CSS v4 · PrismJS · Three.js
