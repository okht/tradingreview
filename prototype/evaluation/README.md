# 投资复盘产品评测

本目录把「产品契约是否兑现」与「完成任务的质量」分开评估。`rubric.json` 中的阈值均为验收目标，不能当作已观察结果。

当前执行优先级：先按 `CORE_ACCEPTANCE.md` 跑通核心端到端链路和异常恢复，再评AI效果。50组真实模型批量评测暂不执行；runner先用于离线核对和保留后续能力。

## 什么是好

首先遵守四个零错误硬门槛：无时点泄漏、无虚构来源或无依据核心事实、无确定性预测及直接买卖建议、无数据缺失/冲突/失效/失败正常化。任一核心违规都需要优先修复，平均分不能抵消。

再按1–5分评价回答当前问题、证据贴合、行为归因谨慎、可用学习及总结时机、不确定性处理。材料不足时准确追问、保留未知，也可以获得高分；不要求每次都强行生成教训。交互与恢复独立评分，覆盖引用定位、纠错生效、旧回答失效、保存回执、失败恢复及窄屏操作。

目标为：四项硬门槛零违规且完成审阅、总体调用完成率至少95%、各AI质量维度均分至少4且无1分。尚未调用或未审阅时只报告待验收。

## 数据与分层

用户要求50组真实股票标的的模拟交易行为，每组20–40笔，最细粒度15分钟。真实股票身份、模拟成交与行情来源必须分别标明。构造行情不能作为实际市场表现的证据。

- `fixtures/equity-50/manifest.json`：正式50组清单，`datasets` 内含唯一 `id`、`files.bundle/context/oracle/candles15m` 和文件散列；oracle含8类问题及独立账本。通用 `cases` 数组格式也支持。
- 资料路径相对manifest目录，不能越出该目录。也支持 `casePath` 指向含 `bundle`、`context`、`prompt` 的完整案例JSON。
- `bundle` 使用产品的 `huikan-review-bundle` version 1；`context` 使用实际服务契约，保留背景与事件。
- `results/<run>/`：每例输入/输出、工具事件、耗时、修复状态、错误、汇总与待人工评分表。
- 离线契约测试、已有模拟提供方测试、真实模型运行、人工语义审阅分别报告。禁止用模拟回答填充真实模型结果。

## 运行

需要已安装项目依赖及Node.js 22.19+。离线运行不需要模型或金融凭证，不会创建模型提供方：

```sh
node scripts/run-product-evaluation.mjs --mode offline --output evaluation/results/offline-baseline
```

离线实际调用 `readTradeFile`、`validateContext`、`buildEvidence`、`createReviewTools` 和图表选择器，逐例检查导入字段、缺失费用、引用身份、事后信息隐藏、15分钟视角和修改未来价格后的当前视角不变性。另外独立计算BigInt分单位现金账本、逐周期盈亏、费用、持仓和T+1，并将每根15分钟OHLC与原始5分钟观测及参考CSV全量比较。多周期合计现金盈亏不冒充单周期收益率。检查分母按实际机会分别统计；无适用条件的项目保持不适用。该结果不衡量AI语义质量。

真实运行前在目标本地服务的产品设置完成ChatGPT授权，并明确选择实际可用模型。以下 `MODEL_ID` 须替换为已连接模型；runner不会读取密钥、查找OAuth文件或主动登录：

```sh
node scripts/run-product-evaluation.mjs --mode live --base-url http://127.0.0.1:8788 --model MODEL_ID --limit 3 --offset 0 --output evaluation/results/live-pilot
node scripts/run-product-evaluation.mjs --mode live --base-url http://127.0.0.1:8788 --model MODEL_ID --output evaluation/results/live-50
```

真实调用始终提交 `{provider:'openai',auth:'oauth',model:MODEL_ID}`，通过当前 `/api/agent/stream` 顺序处理。显式 `financialConfig:{}` 禁用本次自动金融联网取证，使用评测包材料；不调用真实投资账户。产品服务会存储独立分析运行快照，runner不写入用户工作区，也不创建或修改真实成交。

`--question-index 0` 默认每组第一问，`1`选择第二问，以此类推。题目声明 `selectedTradeIds` 时，live请求只纳入对应交易与材料。`--baseline-no-market` 仅用于尚未加载新行情契约的旧服务基线：删除请求marketData并明确告诉模型行情未提供；结果不能计入15分钟能力验收。`--server-version`记录运行者确认的服务提交；本地源码指纹不能证明未重启的服务已经加载新源码。当前不需要执行旧服务live基线。

授权未连接时逐例记为 `blocked` 并保留全部计划分母。输入或单例调用失败后继续其他案例。默认两次请求启动至少间隔5100ms，单请求客户端超时120秒；产品自身时限仍生效。

```sh
node scripts/run-product-evaluation.mjs --mode live --base-url http://127.0.0.1:8788 --model MODEL_ID --output evaluation/results/live-50 --resume
node scripts/run-product-evaluation.mjs --mode live --base-url http://127.0.0.1:8788 --model MODEL_ID --output evaluation/results/live-50 --resume --retry-failed
```

`--resume` 跳过已有结果并补齐未执行案例；`--retry-failed` 显式重试失败或阻塞案例，保留每次尝试。模式、模型、案例范围、数据集与关键源码指纹必须一致；修复代码后需使用新输出目录，才能保留清晰的修复前后比较。退出码0表示所选调用/离线检查完成，2表示有失败、阻塞或未完成，1表示运行配置错误；退出码0不表示AI质量合格。

## 人工评分及分母

每次运行创建 `manual-review.json`。人工逐例填写审阅者、时间、总依据、四个硬门槛的 `pass/fail/not_applicable` 与原因，以及六项质量分数和原文依据。未填写部分保持pending/null；自动脚本不按关键词给语义满分。

完成评分后用相同命令增加 `--resume` 重新汇总，无需重新请求已完成案例。只有审阅者、时间及依据齐全的评分才进入汇总。

- 总体完成率分母：本轮全部计划案例，包含输入失败、未授权、网络失败和未完成案例。
- 各硬门槛违规率：该项已人工审阅且适用的输出数，同时显示待审、不适用、无输出及计划总数。
- 引用存在性：实际引用ID机会数；这项通过不能证明引用支持结论。
- 质量均分：该维度完成人工评分的案例数，同时显示计划总数。交互维度独立展示。
- 耗时：有效结果p50/p95及样本数；失败耗时单列。
- 格式修复率：SSE观察到重新校验状态的请求数/实际请求数。没有该事件不能推断模型内部是否自我修正。

目前产品SSE只公开工具名称和running/complete/error，runner保存这一粒度；不会声称获得完整工具参数、工具原文或模型隐藏思考。输入输出会脱敏凭证形态、账号标识和邮箱，文件来自构造评测集。最终公开发布仍需人工检查结果包。

## 一轮badcase修复

先按硬门槛严重性、真实复现次数和影响范围排序。每项记录案例ID、失败结论、原始证据、产品期望、根因、修复位置和修复后结果。同一输入在新目录复测，并加入相邻正常样本检查误拒。仅完成规则回归时写规则回归通过；只有真实模型重新运行并人工核对后，才能记录真实AI效果改善。

使用 `REPORT_TEMPLATE.md` 整理最终结果；调用成功数、AI通过数、人工已审数和未完成项须分别列出。
