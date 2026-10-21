# 完整测试与构建记录

最新结果为多周期核算修复后的 **567/567 通过**，见 [最终测试日志](final-validation-multi-cycle.log)；[云端构建](final-cloud-build-multi-cycle.log) 与 [本地构建](build-local-final.log) 均通过。下文保留 04:47 的 565 项阶段记录，未与最终测试数相加。

最新执行时间：2026-10-22 04:47（UTC+08:00）。在「面向未来的结构化检查项免于历史归因误拦，明确过去声明继续校验」修复落盘后，重新运行完整现有测试和云端构建。本记录与所链接日志已更新为该次结果。本次验证未修改功能、未新增测试，未操作浏览器或启动/停止 `8791` 服务。

| 项目 | 结果 | 证据 |
|---|---|---|
| 全部现有测试 | **565/565 通过**；52 个测试文件；0 失败、0 取消、0 跳过；退出码 0；12533 ms | [final-validation-test.log](final-validation-test.log) |
| 产品云端构建 | **通过**；RSC、client、SSR 构建完成；退出码 0；输出到 `dist` | [final-validation-build.log](final-validation-build.log) |
| 当前页面产物保护 | `dist-local` 构建前后文件内容指纹一致 | 下方指纹与执行范围 |

## 执行方式

环境为 Windows、PowerShell 7.6.5 Core、Node v24.19.0。工作目录为 `C:/Users/ROG/Desktop/同花顺笔试/prototype`，使用当前含未提交修改的工作树。

- `package.json` 的测试脚本为 `node --test tests/*.test.mjs`。本轮枚举全部 52 个 `tests/*.test.mjs` 后执行 `node --test --test-reporter=spec`，范围与该脚本相同；只增加可读日志格式。
- `package.json` 的 `build` 脚本为 `node scripts/build-product.mjs`。该脚本先设置 `HUIKAN_CLOUD=1`，再调用 vinext/Vite 云端配置。本轮直接执行该入口，构建目录为 `dist/client`、`dist/server` 和 `dist/.openai`。
- 未执行 `build:local`，因为 `vite.config.js` 的本地分支输出到 `dist-local`，该目录正在供主线程页面验收使用。
- 测试开始于 04:47:36，结束于 04:47:49；构建开始于 04:47:36，结束于 04:47:47。两项独立执行，原始日志包含退出状态。
- 最新学习项校验回归包含 `structured future checklist uses prospective semantics without a mandatory disclaimer` 与 `the prospective reminder exception does not exempt affirmative historical claims`，均通过；日志第 494–499 行保留相邻边界测试。

## 构建提示

构建成功，日志保留两项非阻断提示：分包函数缺少用于耗时报告的 `debugName`；vinext 静态分析无法分类 `/` 的动态 API 使用，路由显示 `Unknown`。本轮未为这些提示变更功能。

## 页面产物保护

构建前后分别枚举 `dist-local` 下全部文件，按相对路径排序，计算各文件 SHA-256，再对「路径与文件散列清单」计算 SHA-256。两次结果均为：

`936b6f8fc8f98712ae14eb690ee5a8d379a085a82ae0d4bebbd65d2f8211b3c3`

因此本轮云端构建未改变当前页面所用 `dist-local` 的文件内容。没有重新加载、重启或停止正在验收的 `8791` 服务。

## 结论边界

本记录确认执行时当前代码的完整现有自动测试及云端构建通过。565 为本轮实际测试数，未与此前 520 项完整回归或 330 项异常定向回归相加。

真实页面的经典主流程仍由主线程继续验收；本轮没有新的真实模型调用、页面操作或刷新恢复证据，未据此将整条核心链路标为通过。既有真实失败及后续页面结果继续记录在 [核心实测记录](README.md)；异常测试映射见 [core-exceptions.md](core-exceptions.md)。
