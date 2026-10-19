# 仓库内软件团队改造验证

日期：2026-10-19。状态：实现与本地验证完成，候选 SOP 待人类审定，未启动真实团队。
本记录不是独立评审、需求验收或人类审批。当前目录没有 `.git`，无法绑定提交 SHA
或创建可验证的 Git 差异；验证对象是本次工作区中的源文件。

## 实现范围

- `packages/daemon/specs/agents/software-team/`：七岗位 AgentSpec 和八个专属技能。
- `packages/daemon/src/builtins/workflow-specs/software-team-{pr,product}.yaml`：
  专家结果回调度、架构实现核对、独立评审、测试、需求验收、产品部署复测及返工。
- `team/rig.template.yaml`、`scripts/software-team.mjs`：本仓库固定团队入口，
  七个独立岗位工作目录、共享及岗位知识、持久工作记录。
- `team/PROJECT.md`、标准索引、工具清单、交接及人类决策模板、方法来源和 README。

## 已执行检查

| 检查 | 结果 |
| --- | --- |
| `npm run build` | 四个工作区构建通过；Vite 有已有的包大小及浏览器数据库提示 |
| `npm run lint` | 全部工作区类型检查通过 |
| `node --test scripts/software-team.test.mjs` | 3 项通过：路径、重复准备保留记录、配置错误拒绝 |
| daemon：software-team-rig、software-team-workflow、conveyor-starter、builtin-team-providers、spec-library-starters | 5 个文件，54 项通过 |
| 八个技能的 skill-creator quick_validate | 全部通过，技能编写子任务执行 |
| `node scripts/mirror-skills.mjs --check` | 通过 |
| `node scripts/generate-context-packs.mjs --check` | 57 个 pack 检查通过 |
| `node --import tsx scripts/check-first-run-references.mjs` | 375 个引用通过，5 个已有外部引用未检查 |
| `node --test --test-concurrency=1 scripts/*.test.mjs` | 303 项：297 通过、4 失败、2 跳过 |

最后一项的失败：两项打包检查需要 Git 提交标识，文档守卫需要 Git 跟踪清单，
但本目录没有 `.git`；另一项打包指针检查读取了不存在的 `CHANGELOG.md`。
单独执行文档守卫也因同一原因失败。没有初始化 Git、伪造提交信息或补造变更日志。
未执行全部 daemon/CLI/TUI 测试套件，也没有进行真实模型会话或生产环境验证。

重复相关 daemon 验证：

```bash
node node_modules/vitest/vitest.mjs run --root packages/daemon \
  test/software-team-rig.test.ts test/software-team-workflow.test.ts \
  test/conveyor-starter.test.ts test/builtin-team-providers.test.ts \
  test/spec-library-starters.test.ts
```

## 未落实事项

正式采用 SOP 需要真实人类审定记录。各席 MCP、运维技能来源、部署目标及资源预算
仍待配置；没有配置全局 MCP 或云资源。工作流提供路由和状态约束，尚不认证证据内容、
人类批准身份或代码版本变化。后续修改代码后需要针对新候选重新验证。
