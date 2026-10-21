# 核心异常定向回归记录

执行时间：2026-10-22 04:30:42–04:30:48（UTC+08:00）。本轮执行 **26 个现有测试文件，330/330 通过，0 失败、0 取消、0 跳过**。测试进程耗时 5648 ms，退出码 0。

原始证据：[core-exceptions.log](core-exceptions.log)，汇总在第 340–350 行。日志 SHA-256：`1c0b232c03cccf4cda1e22f2d586e9618934e1f67d4865a876c6d716582c4368`。

本轮验证的是受控自动测试中的异常处理、数据校验、保存与请求隔离。**核心页面端到端验收仍为「进行中」**；本报告不将自动测试计为真实模型质量通过，不把已有页面失败改记为成功。

## 环境与范围

- Windows；PowerShell 7.6.5 Core；Node v24.19.0。完整命令及文件清单在日志第 1–8 行。
- 工作目录：`C:/Users/ROG/Desktop/同花顺笔试/prototype`。Git HEAD 为 `9af4c2209d7c9764d5d7d1d4a4d5bac6d5a73dbc`，执行时含本轮尚未提交的修改，因此该 HEAD 单独无法代表全部被测实现。
- 测试使用构造数据、注入的模型/数据源响应、临时存储、受控错误和回环地址上的合成 HTTP/SSE 服务。部分测试执行真实 Pi 运行循环，但模型输出由测试提供；日志中的 `real Pi loop`、`actual MCP tool` 等名称不表示调用了真实外部模型或金融服务。
- `api.test.mjs` 的 Pi 连接测试使用随机回环端口、假 API Key 和合成 SSE；没有访问产品的 `8788` / `8791` 服务，没有 OAuth 授权或真实模型调用，没有重启或构建。
- 本轮只运行已有测试，未增加用于重复实现逻辑的测试。`agent-run-limits`、`pi-agent`、`validation-failure-observer` 已在所属修改完成后纳入。
- 组件保存处理器与 OAuth 界面的部分测试使用受控 hook/处理器环境，不能代替真实浏览器的点击、焦点、网络和刷新验收。

## E01–E08 对应证据

以下测试名均为本轮日志原名。每项所列测试全部通过；所列范围为代表性证据，完整结果以日志为准。

### E01 非法或缺字段导入

覆盖缺字段、重复成交、账户/标的分组、非法日期、损坏文件、取消，以及人工编辑保留。

- `confirmation rejects duplicate executions, missing ids and mixed instruments` — `tests/import-dialog.test.mjs`；日志第 126 行。
- `missing fields identify the exact information to ask for`、`groups retain every candidate while separating accounts and symbols` — 同文件；日志第 129–130 行。
- `confirmation blocks duplicate, impossible-date and replaced-context candidates` — `tests/agent-conversation.test.mjs`；日志第 23 行。
- `JSON malformed content has a clear corrupt-file error`、`empty, binary unsupported, oversize, and cancelled files have distinct outcomes` — `tests/trade-file-reader.test.mjs`；日志第 321、326 行。
- `editing preserves unknown cash fields and does not turn them into zero`、`AI refinement preserves manual edits and candidates omitted by the model` — `tests/import-dialog.test.mjs`；日志第 125、131 行。

真实页面已有「缺成交时间 → 禁止确认 → 取消后保留原 20 笔」证据：[missing-time-blocked.png](missing-time-blocked.png)。其余非法类型的完整页面修正/取消过程仍待覆盖。

### E02 未连接或失效模型

覆盖连接前不调用、错误配置、连接超时、安全错误、已保存授权的显式验证与暂时性状态故障恢复。

- `waiting for a connected model does not call AI and starts once after connection` — `tests/background-preparation.test.mjs`；日志第 83 行。
- `model configuration rejects credential URL leaks, wrong hosts and malformed auth`、`model connection suppresses upstream exceptions with sensitive status bodies`、`connection timeout returns even if a provider ignores cancellation` — `tests/api.test.mjs`；日志第 61、67–68 行。
- `live request requires a final result, reports server errors and keeps AbortSignal` — `tests/live-services.test.mjs`；日志第 150 行。
- `ModelSettings.jsx: transient status failures preserve authorization and offer retry without login`、`ModelSettings.jsx: background authorization lookup cannot abort or strand an API connection` — `tests/oauth-ui.test.mjs`；日志第 195–196 行；`ModelSetup.jsx` 对应测试见第 201–202 行。

真实页面已验证本机重启后恢复授权并显式验证模型，见 [AUTH_PERSISTENCE.md](AUTH_PERSISTENCE.md)。这不证明授权自然到期、真实服务断开或错误模型后的全部页面恢复流程；这些分支仍待实际验收。

### E03 超时、取消与迟到返回

覆盖前端准备、API SSE、Pi 运行循环和研究请求；取消后释放槽位，迟到结果不写入新请求或其他会话。

- `cancelled old task cannot delete a newer task slot when it eventually returns`、`request abort closes SSE immediately and permits a replacement task`、`server timeout closes SSE and releases a task whose runner ignores cancellation` — `tests/api.test.mjs`；日志第 73–75 行。
- `reimport/retry and cancel discard prior responses even if the transport ignores abort`、`timeout stops preparation without deleting imported data`、`stopping a later batch preserves progress and late transport output cannot commit` — `tests/background-preparation.test.mjs`；日志第 87、89、96 行。
- `a caller abort cancels a pending provider stream`、`an abort during the initial status event prevents a provider request` — `tests/pi-agent.test.mjs`；日志第 213–214 行。
- `an old completion cannot release the busy state or save into a newer request`、`cancellation during a multi-call adoption cannot save either version`、`unmount cancellation sends no state update and ignores a response that arrives later` — `tests/research-request-state.test.mjs`；日志第 253、255、257 行。

真实页面已有 20 笔整组准备 90 秒超时后保留输入、提供重试的记录：[prepare-20-timeout.png](prepare-20-timeout.png)。真实浏览器的取消后立即重发、切会话后旧请求返回、研究取消后再次执行仍待连续验收。

### E04 行情缺失或不兼容

覆盖错误标的/范围、非法 OHLC、未知当前 K 线、时间过滤、缺行情时拒绝构造图表或收益比较。

- `market context rejects unsupported scope, malformed OHLC and invented availability`、`unknown current-bar evidence supports a data limitation without asserting a price or no K-line` — `tests/market-tools.test.mjs`；日志第 181、186 行。
- `imported executions never become synthetic market candles or markers`、`empty cutoff ranges stay empty and non-demo symbols are not placed on demo prices` — `tests/market-data.test.mjs`；日志第 162–163 行。
- `HTTP success with business failure never becomes available market data or reflects upstream messages`、`malformed OHLC, duplicates, string numbers and absent envelope data fail without partial import` — `tests/financial-sources.test.mjs`；日志第 114–115 行。
- `insufficient history and malformed or duplicate OHLC remain unavailable`、`actual ledger rejects missing initial positions, fees, cashflow or market coverage` — `tests/strategy-engine.test.mjs`；日志第 300、308 行。

真实页面仍需分别验证删除行情、错误标的及覆盖断档的提示、比较限制和材料恢复。当前成功导入 15 分钟行情的截图不能替代这些失败场景。

### E05 证据查询失败

覆盖未配置、空结果、发现失败、调用失败、取消、跨标的拒绝，以及成功批次不抹掉先前失败。

- `unconfigured retrieval reports pending without network calls or fabricated evidence`、`fixed official hosts, bounded call count, unsafe definitions and empty results stay explicit` — `tests/evidence-retrieval.test.mjs`；日志第 101、111 行。
- `external source call failure preserves existing-material review and emits a truthful failure state`、`discovery failure stays unavailable and never fabricates evidence or leaks provider errors` — `tests/research-integration.test.mjs`；日志第 240–241 行。
- `prepare external failure preserves unknown candidates and records the source gap` — `tests/prepare-agent.test.mjs`；日志第 233 行。
- `a later successful lookup does not erase an earlier batch source failure` — `tests/background-preparation.test.mjs`；日志第 99 行。
- `prepare synthetic cases do not mix real company news into simulated behavior`、`review also skips real external news for synthetic cases while retaining required local market reads` — `tests/prepare-agent.test.mjs`；日志第 231、234 行。

真实页面第一轮查询失败曾明确呈现失败，但当时错误文案较笼统，见 [review-first-failure.png](review-first-failure.png)。本轮自动测试未证明真实第三方限流/权限拒绝时的整段页面恢复；模拟成交跳过真实新闻的约束仍保留。

### E06 材料更新与来源过期

覆盖成交/背景/模型/范围变化、研究在途失效、检查项来源复核、历史消息隔离与持久化关联。

- `scope changes for selection, background, market data, model endpoint and revision but not draft`、`history never feeds old material or a same-name different endpoint answer into a new run` — `tests/agent-conversation.test.mjs`；日志第 16–17 行。
- `material, method, model, selection, deleted-conversation and switched-conversation changes abort and discard late success`、`the final guard catches changes before the React refresh effect and suppresses stale errors`、`batch invalidation tracks selected source materials and leaves unrelated conversations alone` — `tests/research-request-state.test.mjs`；日志第 251–252、254 行。
- `material revision or source changes after opening block submission without mutating the draft`、`missing or mismatched evidence and analysis sources cannot be promoted into saved reminders` — `tests/learning-actions.test.mjs`；日志第 138–139 行。
- `editing an execution preserves stable identity, associations and hidden notes through persistence`、`time corrections reorder the list without changing links, invalid or stale updates fail atomically` — `tests/review-material-state.test.mjs`；日志第 287–288 行。

真实页面已验证手动改背景后收起旧灰字、保留新输入，见 [现有实测记录](README.md)。正式复盘结果变旧、引用快照回看、来源变化后检查项阻止保存、切换会话的研究迟到返回仍需页面验收。

### E07 保存失败、冲突与重复点击

覆盖服务存储回滚、版本冲突、检查项来源与人工编辑保留、同源重复保存、失败后重试；AI 候选需显式保存。

- `simultaneous writes against one revision have exactly one durable winner`、`actual write failure rolls back memory, leaves disk untouched and permits a later successful commit`、`reads during a failed commit cannot observe an uncommitted revision or run` — `tests/storage.test.mjs`；日志第 290–292 行。
- `two simultaneous writes with the same revision have only one winner`、`save failure emits no result and releases the owner task slot` — `tests/api.test.mjs`；日志第 58、72 行。
- `opening an AI candidate never saves it; explicit save preserves message, run, question and evidence links through roundtrip`、`reopening the same answer reuses saved ID and user edits instead of replacing them with the AI candidate` — `tests/learning-actions.test.mjs`；日志第 135–136 行。
- `concurrent saved-item updates are rejected while unrelated latest workspace changes are preserved`、`failed durable writes leave workspace and editing draft intact, and a later retry saves exactly once` — 同文件；日志第 142–143 行。
- `actual save handler uses latest state and handles two pre-render clicks with one durable item`、`actual save handler leaves editor open and emits no success on write failure, then permits retry` — 同文件；日志第 145–146 行。
- `active transport and persistence failures propagate and unlock for retry` — `tests/research-request-state.test.mjs`；日志第 256 行。

这些测试验证各自保存函数、处理器与存储边界。研究 controller 的注入写入失败测试，无法单独证明方法保存与会话报告已组成同一次浏览器持久化事务。真实页面仍需核对编辑检查项 → 连点保存 → 重开保留人工值 → 刷新恢复，并实际注入本地保存失败和远端冲突，确认编辑保留与回执时机。

### E08 方法与回测异常

覆盖未知方法、未执行动作的虚假回执、部分改进、缺本金、不可用回测、版本冲突与比较口径不一致。

- `an unexecuted research intent cannot publish a completed-save claim and gets one repair`、`unknown method IDs cannot execute inferred operations by silently choosing a different candidate`、`batch endpoint uses only selected datasets and missing capital produces no invented return` — `tests/research-integration.test.mjs`；日志第 242–243、247 行。
- `selecting only stop loss from a three-change proposal reuses its original and excludes unselected changes`、`each selected subset excludes all other proposed constraints`、`UI workflow saves original plus the selected subset and compares those exact versions at shared costs` — `tests/research-selection.test.mjs`；日志第 258、260、266 行。
- `missing capital yields an explicit unavailable pair without comparing actual trades as original rules`、`failure to validate original prevents any save receipt, without mutating the existing library`、`mismatched replay assumptions are rejected as a comparison rather than producing a misleading delta` — `tests/research-workflow.test.mjs`；日志第 271、273、275 行。
- `capacity errors cannot leave only the original version saved`、`an orphan improved proposal cannot claim two versions were saved`、`repeated adoption returns the actual saved names and never claims an idempotent save renamed a version` — 同文件；日志第 276、278、280 行。
- `an explicit unsupported five percent stop loss never silently saves the fixed eight percent option` — 同文件；日志第 281 行。

真实页面仍需在实际模型候选基础上完成指定改进保存、明确本金回测、缺本金/缺行情失败、重复采纳和刷新恢复。日志中的 `UI workflow` 为自动工作流测试名称，不代表本轮操作了浏览器。

## 补充运行边界

Runner 最新资源限制回归见日志第 27–37 行：review 的总 token 上限为 96000，精确上限可通过，超出上限停止；模型轮数与工具数量分别限额；import/prepare/parse/background 保持各自原有限额。此处使用构造用量和假响应，不能推断真实 20 笔回答一定成功。

受控失败观察器回归见日志第 334–339 行：只保留经脱敏的本地诊断，不将被拒原文流向 SSE；观察器错误不改变接受/拒绝结果；诊断与实际不确定性校验保持一致。它们为后续定位真实复盘失败提供依据，本轮未再次调用真实模型。

## 下一步验收边界

依据 [CORE_ACCEPTANCE.md](../../evaluation/CORE_ACCEPTANCE.md)，仍需在同一隔离会话连续完成 C03 复盘 → C04 保存指定方法 → C05 回测 → C06 编辑保存检查项 → C07 刷新恢复，并补齐上文列出的真实页面异常恢复。

已有 20 笔复盘 `INVALID_RESULT` 及分批准备第二批 `MODEL_ERROR` 的记录保留在 [README.md](README.md)。本轮 330 项定向结果不与较早的 520 项全量结果相加，不替代整条核心链路的实际验收，也不构成 50 组 AI 效果评测结论。
