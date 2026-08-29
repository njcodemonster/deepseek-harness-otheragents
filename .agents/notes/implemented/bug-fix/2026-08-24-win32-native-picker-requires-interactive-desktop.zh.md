# Agent Note: win32 原生选择器要求交互式桌面

Status: implemented

[English](2026-08-24-win32-native-picker-requires-interactive-desktop.md) | 中文

## 问题

只要绑定为回环且未设置 SSH 标记，`directory-picker-auto` 在 win32 上就判定为 `native`，并假设任何 win32 进程都能弹出选择器。当 web 服务器运行在操作者看不见的桌面上时，该假设不成立：沙箱化启动（独立的 `exebox-*` 桌面）与服务会话（`Service-0x0-…$`）会把对话框窗口创建到不可见的桌面上。此时选择操作永远不会大声失败——对话框只是不出现——于是“添加工作区”看起来毫无反应，而真实对话框却在隐藏桌面上不断堆积。

## 决策

`resolveDirectoryPickerBackend` 新增一个必填的 `interactiveDesktop` 启动时事实。win32 上由新增的 `hasInteractiveDesktop` 探针采样，该探针通过 koffi（`GetProcessWindowStation`、`GetThreadDesktop`、`GetUserObjectInformationW`）读取进程窗口站与桌面，并严格要求为 `WinSta0\Default`。darwin 采样为 true（不存在探针）；linux 沿用 `DISPLAY`／`WAYLAND_DISPLAY` 信号。探针在非 win32 宿主上不加载 koffi 即返回 true；绑定加载失败则判定为 false——native 后端本就需要同一个 koffi 绑定才能完成选择，因此这类宿主上 `browse` 才是可用的交互。

事实为 false 时，选择器挂载已随包交付的 browse 双面（host 后端 + client 界面），选择器改在浏览器内渲染。web-app bundle 已声明这两个 face，因此无需任何组合改动。

## 验证

resolver 测试固定了新增分支（win32 与 darwin 在 `interactiveDesktop: false` 时判定为 `browse`；linux 忽略该事实）。新增的探针测试用注入的假绑定驱动每一个分支。REAL-composition 的 loader 测试 mock 了探针——操作系统桌面是无法用 env stub 强制的现实——并固定两种结果：交互式宿主挂载 `native`，非交互式宿主挂载 `browse`。

## 考虑过的替代方案

**保留 `native` 并依赖暴露出的失败。** 已拒绝：不可见的对话框不会失败——选择静默挂起，后端的可重试错误界面永不出现，用户只看到“什么都没发生”。

**通过 spawn 出的子进程报告自身桌面来探测。** 已拒绝：子进程继承父进程桌面，结果等价，但启动时进程 spawn 的成本高于进程内 koffi 读取；后者还复用了工作区既有的 koffi 依赖与 native 后端的绑定写法。

**把探针放进 `directory-picker-native`，经 seam 读取。** 已拒绝：判定发生在后端挂载之前，且 `-auto` 引入对 picker 包的 import 会新增一条不存在的依赖边。

**native 选择失败时在运行期回退到 `browse`。** [移除 PowerShell 链的 Note](../simplification/2026-08-04-drop-windows-powershell-picker-fallback.zh.md) 已拒绝该方案：流程 hole 是 `single` 类，选择器在启动时只选一个后端；运行期跨种类跳转会让两个 face 双重挂载。

## 后果

没有交互式桌面的宿主——沙箱化启动、服务会话、远程/无头部署——现在得到浏览器内的 browse 选择器，不可见对话框的症状随之消失。交互式桌面继续使用 `native`。auto 包新增 `koffi` 依赖（工作区依赖树中已存在）以及一个运行在宿主进程中的 win32 探针；其失败模式是保守地判定为 `browse`。相关决策——[原生选择器特性](../feature/2026-07-27-native-workspace-directory-picker.zh.md)、[koffi 对话框层](../feature/2026-08-02-win32-in-process-folder-dialog.zh.md)与[回退标准](../simplification/2026-08-04-drop-windows-powershell-picker-fallback.zh.md)——均保持不变。
