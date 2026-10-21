# 本地 Worker 与 D1 联调记录

验证时间：2026-10-21。结果：通过。测试结束后已确认 `127.0.0.1:8790` 无监听。

使用 bundled Node v24.19.0、Wrangler 4.92.0 与实际 workerd/D1 本地运行时；未远程部署、未访问生产 D1、未调用真实模型或金融账户。

## 验证结果

| 项目 | 结果 |
|---|---|
| 未携带身份请求 `/api/status` | 401 |
| 本机手工注入 `oai-authenticated-user-id` | 200，进入云端 Worker 路径 |
| 非同源请求 | 403 |
| 新用户工作区 | `state:null, revision:0` |
| 两次同版本并发保存 | 一个 200、一个 409 |
| 旧版本再次写入 | 409，原数据保留 |
| 无效工作区覆盖尝试 | 400，原数据保留 |
| 两个用户 | 各自独立 state/revision |
| 凭证字段哨兵 | 重新构建后，API Key/token 字段未写入返回工作区 |
| Worker 关闭后使用同一 D1 目录重启 | Alice revision 2、Bob revision 1 及内容均保留 |
| 本地 SQL 注入的分析快照 | 所有人 200，另一用户 404 |

身份请求头由本次测试手工注入，用于验证 Worker 内部 owner 分区；生产网关对该请求头的签发和剥离未在本机测试。分析快照为带有 `LOCAL SQL FIXTURE ONLY` 标识的 SQL 测试数据，未伪装成模型运行。

机器结果见 [seed-result.json](./seed-result.json) 与 [restart-result.json](./restart-result.json)，断言脚本为 [check.mjs](./check.mjs)。

## 发现并复核的构建问题

1. 旧构建要求 compatibility date `2026-10-21`，当前 workerd 最高支持 `2026-05-22`，首次启动失败。主线程已把源配置固定至 `2026-05-15`；重新构建后无需 CLI 日期覆盖即可启动。
2. 初次旧构建尚未包含凭证别名过滤修复，测试哨兵出现在读回结果中。重新构建当前源码，并使用全新本地 D1 目录后，全部断言通过。没有使用真实凭证。

## 重现命令

以下命令均在 `prototype` 目录运行，以 bundled Node 执行 `node_modules/wrangler/bin/wrangler.js`。首次需选空白的本地持久目录，避免重复创建表。

```text
d1 execute DB --config dist/server/wrangler.json --local --persist-to .wrangler/state/huikan-d1-integration-20261021-8790-r2 --file drizzle/0000_spicy_thor.sql --yes --json
dev --config dist/server/wrangler.json --local --ip 127.0.0.1 --port 8790 --inspector-port 0 --persist-to .wrangler/state/huikan-d1-integration-20261021-8790-r2 --show-interactive-dev-session=false --log-level warn
```

启动后执行 `node verification/local-d1-20261021/check.mjs seed`。关闭 Worker，在同一目录通过 `d1 execute --local --file verification/local-d1-20261021/seed-run.sql` 写入测试快照，按同一命令重启后执行 `check.mjs restart`。本轮已停止全部 8790 测试进程，本地测试数据库保留用于核查。
