# Realtime TeX 增强版

[English](README.md)

这是基于 [Henry Yang 的 Realtime TeX 插件](https://github.com/HenryXiaoYang/realtime-tex-vsc-plugin)独立维护的增强版，保留真正的实时排版，并改善文字和公式清晰度、修订颜色、公式跳转和更新响应。

**支持平台：仅 Apple 芯片 Mac（M 系列）。** 安装包自带增强引擎 `rtex 0.0.5+live.6` 和完整配套文件。插件与引擎整套发布，不自动下载、检查或跟随原作者的引擎更新。

## 安装

1. 安装桌面版 VS Code，以及包含 LuaLaTeX 和论文所需宏包的 TeX 环境。推荐 TeX Live 2026 或更新版本；本版也在 TeX Live 2025 上进行了本地回归测试。[MacTeX](https://www.tug.org/mactex/) 提供完整的 Mac TeX 环境。插件安装包不包含整个 TeX 发行版。
2. 如果装过原版 **Realtime TeX**（`henryxiaoyang.realtime-tex`），先将它禁用。增强版沿用原来的设置和快捷键，两者不能同时启用。
3. 到本仓库的 [Releases／版本下载](https://github.com/hengmamath/realtime-tex-vsc-plugin-personal-version/releases)页面下载 `.vsix` 文件。
4. 打开 VS Code 左侧“扩展” → 右上角 `…` → **从 VSIX 安装…**，选择下载的文件；如果提示重新加载窗口，按提示操作。
5. 打开自己的 `.tex` 文件，运行 **Realtime TeX Enhanced: Open Live Preview to the Side**，或按 **Cmd+Alt+V**。找不到 LuaLaTeX 时运行 **Check Setup**，选择 TeX 的程序目录。常见的 MacTeX 目录是 `/Library/TeX/texbin`。

插件始终使用自带且经过校验的增强引擎与完整配套文件。旧设置 `realtimeTex.serverPath` 和 `realtimeTex.texDir` 仅保留用于迁移，已有值会被忽略，不会加载外部 rtex 程序或支持目录。需要指定 LuaLaTeX 安装位置时，仍可设置 `realtimeTex.texliveBin`。

使用安装包不需要安装 Rust、Git 或另外安装 rtex。Intel Mac、Windows 和 Linux 需要分别构建与测试，目前不在本版支持范围内。

## 已保留的改进

- 默认启用 Type1 和受支持的静态 OpenType/TrueType 文字及公式原生绘制；字体准备结果可在实时编辑中复用，不再显示原版／增强版切换按钮。
- 跨段落、公式、列表、嵌套修订范围和分页时保留正确颜色。
- 改善含引用、`showonlyrefs`、修订环境和附录结构的证明实时编辑。
- 点击公式引用直接跳转；**Cmd+[** 返回，**Cmd+]** 前进。
- 最新段落输入减少排队；复用高清页面背景，减少无关重绘。
- 滚动条更明显；预览变窄再变宽后，工具栏能恢复合适高度。
- 保留 PDF 回退显示、源码定位和 PDF 导出。
- **Follow cursor** 可选择 **Single click（单击）**、**Double click（双击，默认）**、**Off（关闭）**。在源码中点击后，预览跳转并使用与右键 **Show Cursor Position in Preview**（`Cmd+Alt+J`）相同的高亮；双击模式在双击源码单词时触发。键盘移动和输入不会带动预览。也可将 `realtimeTex.followCursor` 设为 `singleClick`、`doubleClick` 或 `off`；旧的 `realtimeTex.syncCursor=false` 在手动选择新模式前仍保持关闭。
- 双击 Preview 使用画面自带的源码文件和行号，支持证明、REV、子文件及编辑、删除、撤销后的行号变化。在已确认的源码行内，正文进一步定位到单词，支持的数学内容定位到公式或公式片段。单个展示公式若被标记到结束符，会在边界明确、源码未变化时选中对应公式范围。匹配不明确或画面尚未跟上该行的修改时，保留可靠的行定位；暂不追踪自定义宏生成的内容，也不保证每个数学符号的精确位置。

首次打开仍需整篇编译。导言区、部分结构性修改、复杂图形及无法安全单独重排的内容，仍可能交给后台整篇编译，以保证排版正确。

## 更新和退回旧版

从本仓库下载新版增强版安装包并安装，插件和引擎会一起更新。保留旧安装包即可退回旧版。

旧设置中的 `installFrom=release/source` 和 `updateCheck=notify/auto` 不会触发原版引擎下载或更新。**Verify Bundled rtex Engine** 只校验当前安装包里的配套引擎。原作者的新改动以后可按需参考，发布不依赖持续同步原仓库。

## 完整代码与后续维护

仓库同时保存插件和底层引擎，方便以后继续修改：

- `src/`、`webview/`、`media/`：插件及预览代码。
- `vendor/engine/`：已经应用增强改动的完整引擎开发源码、固定依赖、测试及来源清单。
- `resources/rtex-engine/`：现有增强引擎、原始增强补丁、校验信息和许可证。
- `resources/rtex-runtime/`：完整配套 TeX/Lua 文件和逐文件校验值。
- `test/`：合成测试材料和回归测试。

安装 Node.js 22 或更新版本后，可以检查与打包：

```sh
npm ci
npm run verify:engine
npm run typecheck
npm test
npm run package
```

在支持的 Mac 上，使用真实自带引擎验证实时排版：

```sh
RTEX_TEST_BUNDLED=1 RTEX_TEST_TEXLIVE_BIN=/Library/TeX/texbin npm test
RTEX_E2E_TEXLIVE_BIN=/Library/TeX/texbin npm run test:e2e
```

第一条命令会运行颜色、证明、公式链接和最新输入投递的实际引擎测试。第二条命令使用隔离的 VS Code 设置及合成文件，并检查旧引擎路径设置无法覆盖自带引擎组合，不修改自己的论文。测试解压后的安装包时，可将 `RTEX_E2E_EXTENSION_PATH` 设为其中的 `extension/` 目录。

如果要重新构建底层引擎，安装 Rust/Cargo 后运行 `npm run build:engine`。它只构建仓库内保存的源码，按锁定的依赖版本构建，不拉取原作者的最新引擎，也不会自动替换发布的引擎。首次构建可能需要下载锁定的依赖。详细步骤见[引擎维护说明](vendor/engine/README.enhanced.md)。

每次推送到 `main` 和每个合并请求都会在 Linux 上校验源码和引擎配套关系，运行类型检查和单元测试并打包。与版本号匹配的标签（或手动运行）还会在 Apple 芯片 Mac 上运行锁定依赖的引擎构建、Rust 单元测试、实际引擎测试和针对安装包的 VS Code 集成测试。检查通过后才生成安装包和 SHA-256 校验文件。

## 论文与个人文件

论文保留在自己的电脑。仓库和安装包不包含个人论文、截图、预览生成文件、调试包、个人设置或临时文件。调试功能默认关闭；手动开启后产生的本地调试包可能包含论文源码，请不要上传。仓库的测试文件为合成材料或原项目公开测试材料。

## 来源与许可证

采用 MIT 许可证。原插件版权 © 2026 Henry Yang。引擎基于 realtime-tex `v0.0.5`，原始提交为 `e0ad11765ec016846b6e07619081f0528621636b`，版权属于 Henry Yang 及 realtime-tex contributors。根目录、引擎源码和资源中保留原有版权及许可声明；随插件打包的第三方库声明见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。此增强版独立维护，不代表原作者认可或提供支持。
