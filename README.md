# @dsh-external/dsh-skill-scheduler

按需技能调度器（v0.2）：自动发现所有插件携带的技能，设置页逐技能配置
启用 / 全局注入 / 调用模式（自动 · 手动）。

## 功能

- **自动发现**：扫描 profile `node_modules` 顶层包 + `@scope/*`，凡带 `skills/`
  目录的包自动纳入（新增插件自动读取，无需改配置）。旧 `sources` 配置仍兼容
  （合并，配置优先）。
- **每技能独立开关**（设置页「Skill 调度器」栏，`settings.yaml` 段
  `dsh-skill-scheduler`）：
  - `enabled`：启用/禁用（禁用 = 完全不参与）
  - `globalInject`：全局注入——每次生成系统提示都注入该技能全文
    （无论何时、新窗口、每次回答），注入后不进目录
  - `mode`：`auto` 自动（技能全量进目录，AI 根据用户回答自主选择调用）/
    `manual` 手动（仅当最近用户消息命中技能名/触发词时才进目录）
- **默认调用模式** `defaultMode`：auto / manual，未单独设置的技能跟随。

## 机制

- skill provider `dsh-skill-scheduler`（rank 600，`list()` 返回
  `{ candidates, complete:false }` 实时过滤）。
- **调度引导**：`system-prompt/assemble` 在系统提示**开头**注入
  `skill-scheduler-guide` 段，告诉 AI 何时/如何调用 skill 工具、点名必用、
  全局注入技能直接遵循（技能清单由 dsh-tool-skill 的 available_skills 目录
  提供，不重复列描述）。
- **全局注入**：`globalInject` 技能在 assemble 时追加 `skill-inject:<name>`
  段（`<skill_content>` 渲染与 dsh-skill 同构）。
- 设置页 UI：`GET /skill-scheduler/catalog`（技能列表 + 配置）、
  `POST /skill-scheduler/config`（写配置，深 merge），同源校验。
- 不注册任何工具。

## 构建与注入

```bash
DSH_CHECKOUT=<checkout> bash scripts/build.sh   # git bash；Windows 需 git bash 而非 WSL bash
```

构建产物 `lib/index.js` + `lib/client.js`。热重载 host 半
（dev_reload_package）后 client 通常随补扫自动注册（bundle 200 即成功）；
若仍显示 client ✗，重启 DSH Desktop 即可（dsh-client-modules 的 pkgMeta
缓存启动时的 dsh.client 声明）。

## 与 dsh-design-skills 的关系

dsh-design-skills 的原 provider 在 profile `cordis.patch.yml` 中被 disabled，
由本插件接管其 10 个设计技能目录（避免技能每轮出现在目录）。
