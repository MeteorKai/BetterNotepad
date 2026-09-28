<div align="center">
  <img src="src-tauri/icons/128x128.png" width="96" alt="BetterNotepad 图标" />
  <h1>BetterNotepad</h1>
  <p><strong>写得轻松，改得顺手。</strong></p>
  <p>写笔记、改配置、预览 Markdown、运行脚本，在一个窗口里完成。</p>
  <p>
    <a href="https://github.com/MeteorKai/BetterNotepad/releases"><img src="https://img.shields.io/github/v/release/MeteorKai/BetterNotepad?label=release" alt="最新版本" /></a>
    <img src="https://img.shields.io/badge/Windows-x64-0078D6?logo=windows&amp;logoColor=white" alt="Windows x64" />
    <img src="https://img.shields.io/badge/Tauri-2-24C8D8?logo=tauri&amp;logoColor=white" alt="Tauri 2" />
  </p>
  <p>
    <a href="https://github.com/MeteorKai/BetterNotepad/releases"><strong>⬇ 下载 Windows 安装包</strong></a>
    · <a href="#功能亮点">功能亮点</a>
    · <a href="#从源码运行">从源码运行</a>
  </p>
</div>

---

BetterNotepad 是一款面向 **Windows** 的文本与轻量代码编辑器。它把日常编辑放在第一位：打开就能写；需要查找项目内容、预览 Markdown 或运行脚本时，也不用换工具。

> 不是把一整套 IDE 搬进记事本，而是在需要的时候，多给你一点能力。

## 功能亮点

| 场景 | BetterNotepad 能做什么 |
| --- | --- |
| 📝 **专注编辑** | 多标签、拖拽排序、最近文件、自动缩进与括号匹配；重启后尝试恢复上次的未保存标签。 |
| 🎨 **看着舒服** | Light / Dark / Warm 三套主题，中英双语界面，以及可选择开启的 3D 看板娘。 |
| 🔎 **快速定位** | 文件内查找替换支持大小写、正则表达式和捕获组；打开文件夹后可跨文件搜索。 |
| 📁 **处理文件** | 侧边栏文件树；支持 UTF-8、GBK、UTF-16 等编码与 LF / CRLF 行尾切换。 |
| ✍️ **写代码与文档** | 常见语言语法高亮；Markdown 分栏预览与代码高亮；大文件会自动降低高亮开销。 |
| 🖥️ **运行与交互** | 自动发现或手动配置本机解释器；在底部运行脚本、查看输出，或使用交互式终端。 |

## 下载与安装

前往 **[GitHub Releases](https://github.com/MeteorKai/BetterNotepad/releases)**，下载 `BetterNotepad_<版本号>_x64-setup.exe` 并运行安装。

- 当前提供 **Windows x64** 安装包。
- 如果希望双击 `.txt` 时使用 BetterNotepad，请在 Windows 的“打开方式”中将它设为默认应用；安装程序不能替你保证默认关联。
- 编辑文本无需配置解释器；**运行代码**需要电脑上已安装对应语言的解释器或运行时（例如 Python、Node.js）。

## 快速上手

1. **打开文件或文件夹**：用标签页编辑多个文件；打开文件夹后可使用侧边栏文件树和跨文件搜索。
2. **预览 Markdown**：打开 `.md` 文件，在编辑器右上角切换分栏预览。
3. **运行脚本**：在“设置 → Interpreters”确认解释器路径，打开受支持的脚本后按 `Ctrl+Enter`。需要交互输入时可使用底部终端。
4. **调整习惯**：用工具栏切换主题，在设置中选择语言、字体、缩进和默认行尾。

### 常用快捷键

以下为编辑器快捷键；焦点在终端时，按键优先交给终端处理（字号缩放除外）。

| 快捷键 | 操作 |
| --- | --- |
| `Ctrl+N` / `Ctrl+O` | 新建 / 打开文件 |
| `Ctrl+S` / `Ctrl+Shift+S` | 保存 / 另存为 |
| `Ctrl+F` / `Ctrl+H` | 查找 / 替换 |
| `Ctrl+Shift+F` | 跨文件搜索 |
| `Ctrl+Tab` / `Ctrl+Shift+Tab` | 切换标签 |
| `Ctrl+Enter` | 运行当前文件 |
| `Ctrl+/` | 切换行注释 |
| `Ctrl+=` / `Ctrl+-` / `Ctrl+0` | 放大 / 缩小 / 重置字号 |

## 从源码运行

准备好 Node.js、Rust 工具链和 [Tauri 2 的 Windows 构建环境](https://v2.tauri.app/start/prerequisites/) 后，在项目根目录执行：

```bash
npm ci
npm run tauri -- dev
```

生成 Windows NSIS 安装包：

```bash
npm run tauri -- build --bundles nsis
```

构建产物位于 `src-tauri/target/release/bundle/nsis/`。`npm run build` 只构建前端，不会生成桌面安装包。

## 技术栈

Tauri 2 · Rust · React 19 · TypeScript · CodeMirror 6 · Tailwind CSS 4 · xterm.js · PrismJS · Three.js

## 更新与反馈

BetterNotepad **不在应用内自动安装更新**。“设置 → About → 检查更新”会打开 Releases 页面，由你选择是否下载新版本。

发现问题或有功能建议？欢迎在 [Issues](https://github.com/MeteorKai/BetterNotepad/issues) 交流。项目采用 Apache-2.0 许可证。
