# 应用内更新与发布

## 用户如何更新

首次使用：手动下载并安装一个**已经包含本功能**的新版本，从安装后的快捷方式启动。旧版 0.4.6 本身没有自动更新能力，不能自行获得本功能。

之后进入「设置 → 常规 → 检查更新」即可：

1. 读取 GitHub 最新正式 Release 的 `latest.json`，仅升级到更高版本。
2. 自动下载 Windows x64 安装包，显示进度并校验签名。
3. 有未保存内容时询问是否保存全部；取消保存、保存失败或仍有未保存内容时停止安装。
4. 有运行中的程序或终端时，先询问是否同意关闭。
5. 覆盖原安装目录并重新启动。Windows 可能显示权限确认。

检查及下载期间暂时禁用应用操作，避免准备重启时继续编辑。下载或校验失败不会启动安装器。直接运行开发/构建目录中的 EXE、移动后的 EXE，以及浏览器预览，不支持自动安装。

## 发布者：首次配置

源码已配置更新地址：

`https://github.com/MeteorKai/BetterNotepad/releases/latest/download/latest.json`

应用内只包含公钥。此次生成的**加密私钥及口令**在本机：

- `D:\notepad-app\.workbuddy\keys\BetterNotepad-updater.key`
- `D:\notepad-app\.workbuddy\keys\BetterNotepad-updater.password.txt`

它们被 Git 忽略，**不会同步到 F 盘仓库**。请安全备份，不要上传到 Release、GitHub 仓库或聊天中。后续版本必须使用同一把私钥；更换或丢失私钥会导致已经安装的客户端无法验证更新。

## 本机打包并发布（推荐）

在 PowerShell 中运行，版本号按实际发布调整。例如首次带更新功能的版本使用 0.4.7：

```powershell
cd D:\notepad-app
npm run release:windows -- -Version 0.4.7
```

该命令会同步修改项目自己的版本字段，构建并签名安装包，再生成 `latest.json`。不会修改依赖的版本号，也不会覆盖当前正在运行的旧 EXE。默认产物目录：

`D:\notepad-app\src-tauri\target\update-release\release\bundle\nsis`

到 [GitHub Releases](https://github.com/MeteorKai/BetterNotepad/releases) 创建标签 **`v0.4.7`** 的正式 Release，并上传同一次打包生成的三个文件：

- `BetterNotepad_0.4.7_x64-setup.exe`
- `BetterNotepad_0.4.7_x64-setup.exe.sig`
- `latest.json`

标签必须带 `v` 且与打包版本一致。确保发布为正式版、非 Draft / Pre-release，并设为 Latest；`releases/latest` 必须指向包含这些文件的 Release。**先上传全部文件，再发布**，避免客户端读到不完整更新。

更新说明可以填写在 Release 页面；如需在清单中保留详细说明，发布前修改 `latest.json` 的 `notes` 字段即可，不要改动 `signature` 和下载 URL。

下次发布例如 0.4.8，只需用同样命令换版本号，再上传新 Release 的三个文件。已安装 0.4.7 的用户即可通过按钮更新。

在 F 盘仓库提交源码前，将此次打包修改的 `package.json`、`package-lock.json`、`src-tauri/Cargo.toml`、`src-tauri/Cargo.lock`、`src-tauri/tauri.conf.json` 同步过去；不要复制私钥或构建目录。

## 在 F 盘或其他构建机器签名

先安全提供同一私钥，并设置环境变量（不要把值写入源码）：

```powershell
$env:TAURI_SIGNING_PRIVATE_KEY = 'D:\notepad-app\.workbuddy\keys\BetterNotepad-updater.key'
$env:TAURI_SIGNING_PRIVATE_KEY_PASSWORD = [IO.File]::ReadAllText('D:\notepad-app\.workbuddy\keys\BetterNotepad-updater.password.txt').Trim()
cd F:\github_desktop\BetterNotepad
npm ci
npm run release:windows -- -Version 0.4.8
```

如果以后改用 GitHub Actions，私钥内容和口令应分别放入仓库的 Actions Secrets：`TAURI_SIGNING_PRIVATE_KEY` / `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`，而不是提交文件。此项目目前使用本机打包流程，不会自动提交、上传或发布 Release。

## 上线前验证

- 在测试机安装首个带更新功能的正式版。
- 发布更高版本及三个更新文件。
- 点击检查更新，确认覆盖**原安装目录**、新版本启动且已保存文件及设置仍在。
- 使用未保存标签测试保存取消/保存失败：不得启动安装。
- 断网或使用错误签名：应提示失败，旧应用继续可用。

本地测试通过并不等于 GitHub 更新已上线；需要实际发布上述文件并完成一次安装版升级测试。

## 更新失败时怎么看原因

界面会分别说明安装记录不匹配、请求超时、DNS/证书异常、清单缺失或格式错误、安装包缺失、签名不匹配、目录权限或磁盘空间不足等原因；原始错误保留在可展开的「技术信息」中，未知错误不会被猜测成网络问题。

如果显示「当前 EXE 没有匹配的安装记录」，说明运行路径没有与正式安装目录匹配，尚不能自动覆盖更新。请运行正式安装包，再从安装后的快捷方式启动。

部分 GitHub HTTP 错误被更新插件合并为“无法获取有效清单”；应用只在遇到这种错误时对配置中的更新地址额外请求一次，以显示实际 HTTP 状态，不扫描其他地址、不跳过签名或 HTTPS 校验。
