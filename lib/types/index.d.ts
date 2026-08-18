/**
 * @dsh-external/dsh-skill-scheduler — 按需技能调度器（v0.2）
 *
 * v0.2 新能力（设置页「Skill 调度器」栏，host 半 HTTP 路由 + client 半 UI）：
 *  - 自动发现：扫描 profile node_modules 顶层包 + @scope/*，凡带 skills/ 目录的
 *    包自动纳入（新增插件自动读取，无需改配置）；旧 sources 配置仍兼容（合并、
 *    配置优先）。
 *  - 每技能独立开关（settings namespace 'dsh-skill-scheduler'）：
 *      enabled       启用/禁用（禁用 = 完全不参与，不进目录、不注入）
 *      globalInject  全局注入：勾选后每次生成系统提示都注入该技能全文
 *                    （无论何时、新窗口、每次回答），不再进目录
 *      mode          调用模式（默认跟随 defaultMode）：
 *                      auto   自动：技能全量进目录，模型根据用户回答自主选择调用
 *                      manual 手动：仅当最近用户消息命中技能名/触发词时才进目录
 *    自动模式下用户也可点名（/skill-name 或说关键词都命中 manual 判定），不冲突。
 *
 * 机制：
 *  - skill provider（name: dsh-skill-scheduler），list() 返回 { candidates,
 *    complete:false }（dsh-skill 不缓存，每次实时过滤）。
 *  - 全局注入：system-prompt/assemble Waterfall 向 sections 追加
 *    skill-inject:<name> 段（renderSkillContent 同构的最小实现，避免运行时依赖）。
 *  - 设置页 UI：webServer 路由 GET /skill-scheduler/catalog + POST
 *    /skill-scheduler/config（trusted 同源校验），client 半注入 settings.section。
 *
 * 性能铁律：本插件不注册任何工具。
 */
import type { Context } from '@deepseek-ai/cordis';
import z from '@deepseek-ai/schemastery';
export declare const name = "@dsh-external/dsh-skill-scheduler";
export declare const inject: string[];
export interface SourceConfig {
    /** npm 包名，技能目录位于 node_modules/<pkg>/skills/<name>/SKILL.md */
    package: string;
    /** 可选：包内 skills 子目录路径（默认 'skills'） */
    skillsDir?: string;
}
export interface Config {
    sources: SourceConfig[];
    /** 额外触发词：技能名 → 关键词数组（合并进自动提取） */
    triggers: Record<string, string[]>;
    /** 开关：未命中任何技能时是否允许「最近一次命中」保持激活（默认 false） */
    sticky: boolean;
}
export declare const Config: z<Schemastery.ObjectS<{
    sources: z<({
        package?: string | null | undefined;
        skillsDir?: string | null | undefined;
    } & import("@deepseek-ai/cosmokit").Dict)[], Schemastery.ObjectT<{
        package: z<string, string>;
        skillsDir: z<string, string>;
    }>[]>;
    triggers: z<import("@deepseek-ai/cosmokit").Dict<string[], string>, import("@deepseek-ai/cosmokit").Dict<string[], string>>;
    sticky: z<boolean, boolean>;
}>, Schemastery.ObjectT<{
    sources: z<({
        package?: string | null | undefined;
        skillsDir?: string | null | undefined;
    } & import("@deepseek-ai/cosmokit").Dict)[], Schemastery.ObjectT<{
        package: z<string, string>;
        skillsDir: z<string, string>;
    }>[]>;
    triggers: z<import("@deepseek-ai/cosmokit").Dict<string[], string>, import("@deepseek-ai/cosmokit").Dict<string[], string>>;
    sticky: z<boolean, boolean>;
}>>;
export declare function apply(ctx: Context, config: Config): void;
