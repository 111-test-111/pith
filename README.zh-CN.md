# Pith

[English](README.md) | 简体中文

Pith 是 pi-agent 的桌面客户端，把代码对话、文件、终端和任务管理放在同一个窗口中。它使用 Electron 承载 Pi SDK，界面由 beUI、React 和 Tailwind CSS 构建。

## 产品功能

- **项目与对话**：按文件夹管理会话，也可直接开始无项目对话；支持搜索历史、流式回复、思考与工具过程、追加指令、停止、继续、重试和分叉。
- **文件与变更**：引用文件、添加附件，预览代码、Markdown、数学公式、Notebook、图片和 PDF；查看本轮变更与 diff，接收代理交付的文件。
- **计划与回退**：先提交计划，再明确批准执行；在用户消息前保存检查点，支持文件、对话或组合回退，以及最近一次回退的撤销和重做。
- **并行工作**：任务清单、受管理的后台命令、独立子代理及定时任务。可查看子代理进度、引导或继续其工作；定时任务在应用运行且电脑唤醒时执行。
- **工作面板**：交互式终端、内嵌浏览器、DAP 调试器和画中画。浏览器代理工具需在设置中启用并取得首次使用授权；调试器需启用并安装对应的调试适配器。
- **模型与扩展**：API Key / OAuth 登录，自定义模型与供应商，思考级别、MCP、Skills 和 Pi 扩展管理；可选的 Jev 判断与工作流集成。
- **运行记录**：查看模型请求、工具执行轨迹、上下文估算、Token 用量和费用，导出执行记录。
- **外观与语言**：中文 / English、浅色 / 深色 / 跟随系统、强调色，以及方角 / 连续圆角两种界面风格。

## 从源码运行

需要 **Node.js 22.19 或更高版本**、npm 和 Git。安装会下载依赖及 Electron；若原生依赖无法使用预编译包，还需要对应平台的 C/C++ 编译工具链。模型请求需要已配置的供应商账号或 API Key。

```bash
npm ci
npm run dev
```

安装脚本会应用当前 Pi SDK 版本的兼容补丁、准备终端原生辅助程序，并生成文件类型图标。不要使用 `--ignore-scripts` 跳过这些步骤。

启动后，在「设置 → 供应商」登录或配置模型；打开项目文件夹，或直接创建无项目对话，再从输入框选择模型和权限模式开始工作。终端、文件预览及执行轨迹位于右侧面板。

Pith 复用 Pi 的本地配置：会话位于 `~/.pi/agent/sessions/`，认证位于 `~/.pi/agent/auth.json`，自定义供应商与模型位于 `~/.pi/agent/models.json`。应用偏好、浏览器数据和本地索引保存在系统应用数据目录中的 `pi-app/`；重命名为 Pith 后继续沿用该目录。

权限模式主要约束应用自带工具的本地文件操作；网络、任意扩展 / MCP、用户终端和调试目标有各自的边界。Plan Mode 也不是整机或网络隔离。具体行为见[开发文档](docs/README.md)。

## 开发

```bash
npm run dev          # 开发模式，支持 HMR
npm run typecheck    # 检查主进程、preload 和 renderer 类型
npm run build        # 生产构建，输出到 out/
npm run preview      # 启动已构建的应用
npm run clean        # 清理构建、打包、缓存及生成资源，保留依赖
```

修改后运行 `npm run typecheck` 和 `npm run build`。项目通过 `scripts/check-*.mjs` 执行针对性的协议、运行时和 Electron UI 检查；按[文档索引](docs/README.md)与 [AGENTS.md](AGENTS.md) 选择受影响的检查，不必把所有套件作为每次修改的入口。

验证完成后可运行 `npm run clean` 回到未构建状态；下次开发或构建会自动重新生成所需的文件类型图标。

| 目录 | 用途 |
| --- | --- |
| `src/main/` | Electron 生命周期、Pi SDK、工具与后台服务 |
| `src/preload/` | 通过 `window.pi` 暴露类型化 IPC |
| `src/shared/` | 跨进程 DTO 和公共协议 |
| `src/renderer/src/` | React 界面、状态、主题及中英双语文本 |
| `scripts/` | 资源生成、兼容准备与验证脚本 |
| `resources/` | 品牌 SVG 和打包所需的原生图标 |
| `docs/` | 保留的架构、功能边界及验证说明 |

界面组件使用 beUI，应用组合放在 `components/app/`；所有新增用户可见文字同时加入英文与简体中文词典。主进程负责 SDK 和系统能力，renderer 仅通过 preload 的 IPC API 访问它们。完整约束见 [AGENTS.md](AGENTS.md)。

UI 图标统一使用 Hugeicons Stroke Rounded，文件类型图标使用 Catppuccin，品牌与供应商标记保留各自的 SVG。`npm ci`、开发和构建会自动生成 `src/renderer/public/file-icons/`，该目录不进入版本控制。

## 打包

```bash
npm run pack         # 当前平台的未安装应用
npm run dist:mac     # DMG + ZIP
npm run dist:win     # NSIS 安装包
npm run dist:linux   # AppImage + deb
```

打包脚本会先构建，产物写入 `dist/`。配置覆盖 macOS、Windows 和 Linux；发布前在目标平台验证原生依赖、终端及沙箱行为。代码签名和 macOS 公证凭据由发布者提供。

`resources/pith.svg` 是原生应用图标的母版，`npm run icons` 可重新生成已纳入版本控制的 PNG、ICO 和 ICNS。`resources/pith-square.svg` 仅用于方角界面的新会话品牌标记；Dock 和打包图标始终使用圆角母版。日常构建无需重新生成原生图标。

## 文档与许可

[docs/README.md](docs/README.md) 提供开发文档入口；[AGENTS.md](AGENTS.md) 是仓库协作规范。项目采用 [MIT License](LICENSE)，第三方依赖与资源遵循各自许可证。
