# SoftwareTeam

基于 OpenRig 重构的专业软件团队，本仓库就是团队的项目与工作空间。
固定七位常驻专家：调度、需求、架构、开发、评审、测试、运维。
默认与调度专家沟通，也可以直接进入指定专家的现有终端会话。

| 专家 | 主要责任 |
| --- | --- |
| 调度 | 澄清目标、调配工作、核对证据、放行或返工，与人类讨论争议 |
| 需求 | 分析需求、制定验收标准，测试通过后检查最终交付物 |
| 架构 | 设计与实现核对、长期技术演进、技术债管理 |
| 开发 | 编写代码、自测、修复问题，验证自己使用的 subagent 结果 |
| 评审 | 独立代码审核、提供问题依据、复核修改 |
| 测试 | 实际测试新功能、复现缺陷、回归并验证修复 |
| 运维 | 配置资源、维护服务器、部署复测、恢复事故并提出整改需求 |

每次专家交接都返回调度检查。PR 经评审、测试和需求验收后交付，
不要求跟进到合并；后续修改需要重新确认相关结论。
产品交付还必须经过部署与线上复测。运维恢复服务不等于永久修复完成。

## 仓库内的团队入口

- [团队上下文与工作约定](team/PROJECT.md)
- [七岗位团队配置](team/rig.template.yaml)
- [专属技能源码](packages/daemon/specs/agents/software-team/)
- [PR 工作流](packages/daemon/src/builtins/workflow-specs/software-team-pr.yaml)
- [产品工作流](packages/daemon/src/builtins/workflow-specs/software-team-product.yaml)
- [知识](team/knowledge/project-facts.md)、[工作记录](team/records/README.md)、[交接模板](team/templates/handoff.yaml)
- [标准审定状态](team/standards.yaml)、[工具接入状态](team/tools.yaml)、[技能方法来源](team/SOURCES.md)

这些 SOP 是根据已讨论职责改写的候选稿，需要人类专家审定。
专家可以自行更新事实、工作记录和经验；修改 SOP、评判标准及交付门槛，
以及接受架构风险或延后技术债，由人类决定。

## 准备和使用

需要 Node.js 22 或 24、tmux，以及已登录的 Codex 或 Claude Code。
使用本仓库构建的 OpenRig CLI/daemon；已安装的旧版本不一定识别新增技能和工作流。

```bash
npm ci
npm run build
npm run team:prepare -- --runtime codex
# 使用 Claude Code 时改为 --runtime claude-code
```

准备命令只生成 `team/rig.local.yaml` 并创建仓库内工作目录，不启动专家、
不修改知识记录、不配置全局 MCP。七位专家使用独立工作目录，代码仍是同一份项目源码。

人类审定候选 SOP、确认选用的运行时后，使用既有命令预检和启动：

```bash
rig up ./team/rig.local.yaml --plan
rig up ./team/rig.local.yaml
rig terminal open software-team --window
rig send team-coordinator@software-team '<交付 PR 或产品的具体目标>'
```

不要追加 `--cwd .`，它会覆盖每个专家独立的工作目录。
启动仍会执行 OpenRig 原有的 provider 集成和信任设置，见
[运行时说明](docs/reference/rig-spec.md)。
`rig terminal open` 沿用现有终端查看团队，不新建网页或空闲任务展示。

## 当前边界

已接入七岗位技能选择、常驻生命周期、仓库内记录路径和两条工作流路由。
MCP、运维外部技能来源、云资源和目标环境仍待落实，详见工具清单。
目前由专家和调度检查证据内容、版本适用性及人类决策依据；
工作流本身尚不提供这些判断的强制认证，也不会自动发现代码版本变化。

OpenRig 的数据库和会话状态继续使用其实例目录；项目知识、交接和工作证据保存在本仓库。
从旧版 OpenRig 迁移已有实例时，先阅读 [实例目录与迁移约定](docs/reference/instance-layout.md)，
由 [升级技能](skills/_canonical/core/openrig-upgrade/SKILL.md) 核对和执行迁移。
全新安装若因未生成的 workspace bin 导致 `npm ci` 失败，可先执行
`npm ci --bin-links=false`，再执行
`npm rebuild typescript vitest vite tsx esbuild --bin-links=true` 恢复构建工具入口。

## 开发与来源

`npm run build` 构建各工作区，`npm run lint` 执行类型检查，
`npm test` 运行仓库和工作区测试。本次团队准备脚本另可用
`node --test scripts/software-team.test.mjs` 验证。

底层沿用 [OpenRig](https://github.com/mvschwarz/openrig)，保留其 CLI、daemon、
终端、队列和工作流实现。历史通用模板暂时保留供兼容，本项目入口以 `team/` 为准。
许可证为 [Apache-2.0](LICENSE)。

本仓库版本发布见 [GitHub Releases](https://github.com/lw-liuwang/SoftwareTeam/releases)，
变更记录见 [CHANGELOG.md](CHANGELOG.md)。当前首次源码预发布版本为 `v0.6.12`，
未通过的检查及使用边界见 [发布说明](docs/releases/v0.6.12.md)。
