# v0.6.12 发布验证记录

日期：2026-10-19。渠道：GitHub 源码预发布。
用户已明确要求初始化 Git、创建 CHANGELOG 并向本仓库远端发布。
初始源码提交：`d1cdf68`；最终修正随 `v0.6.12` 标签记录。
本记录补充先前的 `team-refactor-verification.md`，该历史记录所述无 Git 状态已解除。
这不是独立专家评审、需求验收或人类对 SOP 的审定。

## 通过的检查

| 检查 | 结果 |
| --- | --- |
| `npm run build` | 通过，保留已有 Vite 提示 |
| `npm run lint` | 全部工作区通过 |
| `npm run test:repo` | 303 项：302 通过、1 跳过；含打包和隔离安装 |
| TUI 完整套件 | 113 个文件、1008 项通过 |
| 团队改造定向测试 | daemon 54 项及准备脚本 3 项通过 |
| 八个专属技能校验 | 通过，见先前改造记录 |

CLI 首轮完整套件：291 个文件，4850 项通过、21 项失败、6 项跳过。
失败时仓库打包套件同时清理、重建 CLI 生成目录，导致生成模块缺失。
打包结束后，在 `packages/cli` 执行：

```bash
node ../../node_modules/vitest/vitest.mjs run \
  test/scope-slice-claims.test.ts test/front-door.test.ts --maxWorkers=1
```

两个文件 50 项全部通过。没有再次运行完整 CLI 套件。

daemon 首轮完整套件：1044 个文件，17503 项通过、17 项失败、7 项跳过、5 项待实现。
首轮从仓库根目录通过 `--root packages/daemon` 启动，未改变进程工作目录。
依赖相对路径的测试因此失败。在正确工作目录重跑，或修正文档与测试后：

| 文件 | 复测结果 |
| --- | --- |
| `control-plane-census.test.ts` | 19 项通过，使用正确工作目录 |
| `find-polluter-script.test.ts` | 7 项通过，使用正确工作目录 |
| `openrig-upgrade-skill.test.ts` | 48 项通过，README 保留迁移入口，详细合同检查参考文档 |
| `seat-launch-environment-regression.test.ts` | 25 项通过，独立 Node 路径夹具兼容系统 Node |

## 未通过的检查

在 `packages/daemon` 串行复测六个剩余文件，13 项中 8 通过、5 失败。
命令：

```bash
node ../../node_modules/vitest/vitest.mjs run \
  test/find-polluter-script.test.ts \
  test/tmux-exec-transport-native.test.ts \
  test/stub-runner-determinism.test.ts \
  test/stub-runner-activity-e2e.test.ts \
  test/terminal-pipe-utf8.test.ts \
  test/tmux-pane-cwd-native.test.ts --maxWorkers=1
```

| 文件 | 失败表现 |
| --- | --- |
| `tmux-exec-transport-native.test.ts` | 捕获结果缺少预期命令输出 |
| `tmux-pane-cwd-native.test.ts` | pane cwd 为测试进程目录，未匹配指定目录 |
| `terminal-pipe-utf8.test.ts` | 原生管道输出等待超时 |
| `stub-runner-activity-e2e.test.ts` | 活动事件到达顺序不符合预期 |
| `stub-runner-determinism.test.ts` | 两次活动事件序列不同 |

这些问题没有修复，也没有确认全部根因。源码发布标记为预发布并公开披露。
未在最终提交重新执行全部 daemon、CLI 套件。未进行真实模型或生产环境验收。
候选 SOP、MCP、运维来源和部署资源仍受原有未落实事项约束。

## 证据

原始日志位于本地忽略目录 `.evidence/release-v0.6.12/`：
`repo-tests.log`、`typecheck.log`、`tui-tests.log`、`cli-recheck.log`、
`daemon-tests.log`、`upgrade-recheck.log`、`census-recheck.log`、
`seat-environment-recheck.log`、`daemon-native-recheck.log`。
日志未随源码发布；本记录保留命令、结果和已知限制。
