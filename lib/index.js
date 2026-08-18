import { createRequire } from 'node:module';
import { readdirSync, readFileSync, existsSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import z from '@deepseek-ai/schemastery';
import { settingsNamespace } from '@deepseek-ai/dsh-settings';
export const name = '@dsh-external/dsh-skill-scheduler';
export const inject = ['skills', 'settings', 'webServer'];
/** 与 @deepseek-ai/dsh-skill 的 BUNDLED_SKILL_RANK(600) 同级即可；本 provider 独占这些技能名。 */
const PROVIDER_RANK = 600;
const SKILL_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
/** provider 名字（candidate.provider 必须 === 它，dsh-skill 校验）。 */
const PROVIDER_NAME = 'dsh-skill-scheduler';
// ── 设置 namespace（设置页 UI 读写；settings.yaml 落盘段名 'dsh-skill-scheduler'） ──
const SETTINGS_NS = settingsNamespace('dsh-skill-scheduler');
/** schemastery 无 z.enum，用 union(const) 表达枚举；default 需链式设置在 union 上。 */
const MODE_SCHEMA = z.union([z.const('auto'), z.const('manual')]);
const SkillSettingsSchema = z.object({
    defaultMode: MODE_SCHEMA.default('auto').description('默认调用模式：auto=AI 自主选择，manual=仅用户点名/触发才启用'),
    skills: z.dict(z.object({
        enabled: z.boolean().default(true).description('启用该技能'),
        globalInject: z.boolean().default(false).description('全局注入：每次回答都注入全文'),
        mode: MODE_SCHEMA.description('该技能的调用模式（缺省跟随 defaultMode）'),
    })),
});
export const Config = z.object({
    sources: z
        .array(z.object({ package: z.string().required(), skillsDir: z.string() }))
        .default([])
        .description('技能源包列表（package 为可解析的包名，skillsDir 缺省 skills）'),
    triggers: z.dict(z.array(z.string())).default({}).description('按技能名覆盖触发词表'),
    sticky: z.boolean().default(false).description('上次命中的技能在下一条消息未命中时仍保留'),
});
const DEFAULT_SOURCES = [{ package: 'dsh-design-skills' }];
/** 内置触发词表（手工精校，覆盖自动提取的盲区；中英双语） */
const BUILTIN_TRIGGERS = {
    'dark-saas': ['深色', '暗色', 'dark', 'saas', 'linear', '开发者工具', '数据看板', 'dashboard', '后台', '深色科技'],
    'apple-minimal': ['苹果', 'apple', '极简白', 'minimal', '留白', '产品官网', 'premium', '作品集', '简约'],
    'neo-neumorphism': ['新拟态', 'neumorphism', '软浮雕', 'soft-ui', 'soft ui', '柔和', '圆润', '内阴影'],
    'brutalism': ['粗野', 'brutalist', 'neo-brutalist', '硬边框', '高对比', '直角', '无圆角', '粗边框', '反主流'],
    'glassmorphism': ['毛玻璃', '玻璃', 'glass', 'frosted', '磨砂', '半透明', 'blur', '渐变卡片', '通透'],
    'japanese-minimal': ['日式', '和风', 'japanese', '侘寂', 'wabi', '禅意', '明朝体', '宋体', '朱红', '枯山水'],
    'cyberpunk': ['赛博', 'cyberpunk', '霓虹', 'neon', '发光', '故障', 'glitch', '未来感', '科幻', 'sci-fi'],
    'vaporwave': ['蒸汽波', 'vaporwave', 'synthwave', '复古未来', '粉紫', '80年代', '希腊雕像', '网格地平线'],
    'art-deco': ['装饰艺术', 'art deco', 'artdeco', '1920', '盖茨比', 'gatsby', '金黑', '奢华', '几何装饰', '放射'],
    'bento-grid': ['便当盒', 'bento', '网格卡片', '模块化卡片', '功能展示', '卡片布局', 'apple 式', 'feature grid'],
};
export function apply(ctx, config) {
    const sources = config.sources?.length ? config.sources : DEFAULT_SOURCES;
    const extraTriggers = config.triggers ?? {};
    const sticky = config.sticky ?? false;
    const require = createRequire(import.meta.url);
    // dsh-settings：register 返回 controller（get()/update() 均作用于本 namespace）
    const settingsController = ctx.settings.register(SETTINGS_NS, SkillSettingsSchema, { applies: 'live' });
    const webServer = ctx.get('webServer');
    // 最近用户消息缓存：sessionId → 最近一条用户消息文本（由消息监听填充）
    const recentUserText = new Map();
    // 当前正在组装系统提示（即正在生成回复）的会话 id，由 assemble 事件更新
    let activeSessionId = undefined;
    // 最近一次命中（sticky 模式使用）
    const lastHits = new Map(); // sessionId → 命中技能名数组
    // ── 0. profile node_modules 根（自动发现扫描根） ──────────────────────────
    const PROFILE_NODE_MODULES = findNodeModulesRoot(require, import.meta.url);
    function findNodeModulesRoot(req, importMetaUrl) {
        // lib/index.js 向上 4 级 = <profile>/node_modules
        const fromUrl = join(dirname(fileURLToPath(importMetaUrl)), '../../../..', 'node_modules');
        try {
            if (statSync(fromUrl).isDirectory())
                return fromUrl;
        }
        catch {
            /* fallthrough */
        }
        // 回退：从任一已解析包路径向上找 node_modules
        try {
            const p = req.resolve('dsh-design-skills/package.json');
            let d = dirname(p);
            while (d && dirname(d) !== d) {
                const nm = join(d, 'node_modules');
                if (existsSync(nm))
                    return nm;
                d = dirname(d);
            }
        }
        catch {
            /* fallthrough */
        }
        return fromUrl;
    }
    // ── 1. 自动发现：枚举 node_modules 顶层包 + @scope/*，凡带 skills/ 的纳入 ─
    function discoverPackages() {
        const out = [];
        let top;
        try {
            top = readdirSync(PROFILE_NODE_MODULES, { withFileTypes: true })
                .map((e) => e.name)
                .sort();
        }
        catch {
            return out;
        }
        for (const entry of top) {
            if (entry.startsWith('.') || entry === 'node_modules')
                continue;
            if (entry.startsWith('@')) {
                let scoped;
                try {
                    scoped = readdirSync(join(PROFILE_NODE_MODULES, entry), { withFileTypes: true })
                        .map((e) => e.name)
                        .sort();
                }
                catch {
                    continue;
                }
                for (const s of scoped) {
                    if (s.startsWith('.'))
                        continue;
                    if (existsSync(join(PROFILE_NODE_MODULES, entry, s, 'skills')))
                        out.push(`${entry}/${s}`);
                }
            }
            else if (existsSync(join(PROFILE_NODE_MODULES, entry, 'skills'))) {
                out.push(entry);
            }
        }
        return out;
    }
    /** 技能源 = 配置（sources 优先）+ 自动发现（去重） */
    function sourceList() {
        const merged = new Map();
        for (const s of sources)
            merged.set(s.package, s);
        for (const p of discoverPackages()) {
            if (!merged.has(p))
                merged.set(p, { package: p });
        }
        return [...merged.values()];
    }
    // ── 2. 技能加载（磁盘缓存：目录/子目录 mtime 指纹，变才重读） ─────────────
    const loadCache = new Map();
    function resolveSkillsRoot(source) {
        try {
            const pkgJson = require.resolve(`${source.package}/package.json`);
            return join(dirname(pkgJson), source.skillsDir ?? 'skills');
        }
        catch {
            ctx.logger.warn(`[skill-scheduler] 找不到技能包 ${source.package}（已跳过）`);
            return undefined;
        }
    }
    function fingerprintOf(root) {
        let names = [];
        try {
            names = readdirSync(root, { withFileTypes: true })
                .filter((e) => e.isDirectory())
                .map((e) => e.name)
                .sort();
        }
        catch {
            return '';
        }
        let fp = String(statSync(root).mtimeMs);
        for (const n of names) {
            try {
                fp += ':' + n + '@' + statSync(join(root, n)).mtimeMs;
            }
            catch {
                fp += ':' + n;
            }
        }
        return fp;
    }
    function loadSkills() {
        const out = [];
        for (const source of sourceList()) {
            const root = resolveSkillsRoot(source);
            if (!root)
                continue;
            const fp = fingerprintOf(root);
            const cached = loadCache.get(source.package);
            if (cached && cached.fp === fp) {
                out.push(...cached.skills);
                continue;
            }
            const skills = loadSkillsFromRoot(root, source.package);
            loadCache.set(source.package, { fp, skills });
            out.push(...skills);
        }
        return out;
    }
    function loadSkillsFromRoot(root, pkg) {
        const out = [];
        let entries;
        try {
            entries = readdirSync(root, { withFileTypes: true })
                .filter((e) => e.isDirectory())
                .map((e) => e.name);
        }
        catch (error) {
            ctx.logger.warn(`[skill-scheduler] 读取技能目录失败 ${root}: ${String(error)}`);
            return out;
        }
        for (const dirName of entries) {
            const skillFile = join(root, dirName, 'SKILL.md');
            let raw;
            try {
                raw = readFileSync(skillFile, 'utf8');
            }
            catch {
                continue; // 目录无 SKILL.md，跳过
            }
            const parsed = parseFrontmatter(raw);
            if (!parsed) {
                ctx.logger.warn(`[skill-scheduler] ${skillFile} 缺 frontmatter，跳过`);
                continue;
            }
            const skillName = typeof parsed.data.name === 'string' ? parsed.data.name.trim() : '';
            const description = typeof parsed.data.description === 'string' ? parsed.data.description.trim() : '';
            const whenToUse = typeof parsed.data.whenToUse === 'string' ? parsed.data.whenToUse.trim() : undefined;
            if (!SKILL_NAME.test(skillName) || !description)
                continue;
            const keywords = collectKeywords(skillName, description, whenToUse, extraTriggers[skillName]);
            out.push({ name: skillName, description, content: parsed.body.trim(), whenToUse, keywords, path: skillFile, package: pkg });
        }
        return out;
    }
    function collectKeywords(name, description, whenToUse, extra) {
        const set = new Set();
        const add = (t) => {
            const k = t.trim().toLowerCase();
            if (k.length >= 1)
                set.add(k);
        };
        // 技能名本身（用户点名必中）
        add(name);
        // 内置精校表
        for (const t of BUILTIN_TRIGGERS[name] ?? [])
            add(t);
        // 配置覆盖
        for (const t of extra ?? [])
            add(t);
        // whenToUse 整句做子串匹配素材（不拆词，保留中文短语）
        if (whenToUse)
            add(whenToUse.toLowerCase());
        // description 的 "Use when ..." 英文触发片段
        const useWhen = description.match(/use when[^。.]+/i)?.[0];
        if (useWhen) {
            for (const t of useWhen.replace(/^use when/i, '').split(/[,;，、]/)) {
                const k = t.trim().toLowerCase();
                if (k.length >= 2)
                    set.add(k);
            }
        }
        return [...set];
    }
    // ── 3. 设置读取（每技能独立配置，未配置走默认） ───────────────────────────
    function safeSettings() {
        try {
            return settingsController.get() ?? {};
        }
        catch {
            return {};
        }
    }
    function skillConfigOf(st, skillName) {
        const entry = st?.skills?.[skillName];
        return {
            enabled: entry?.enabled !== false,
            globalInject: entry?.globalInject === true,
            mode: entry?.mode ?? st?.defaultMode ?? 'auto',
        };
    }
    function skillConfig(skillName) {
        return skillConfigOf(safeSettings(), skillName);
    }
    // ── 4. 匹配引擎 ──────────────────────────────────────────────────────────
    function matchSkills(text, skills) {
        const normalized = text.toLowerCase();
        const hits = [];
        for (const skill of skills) {
            const matched = skill.keywords.some((kw) => normalized.includes(kw));
            if (matched)
                hits.push(skill);
        }
        return hits;
    }
    /** 取活动会话的最近用户消息；无活动会话时回退到最近写入的一条 */
    function latestUserText() {
        if (activeSessionId !== undefined) {
            const text = recentUserText.get(activeSessionId);
            if (text)
                return text;
        }
        if (recentUserText.size === 0)
            return undefined;
        return [...recentUserText.values()].at(-1);
    }
    function currentSessionId() {
        if (activeSessionId !== undefined)
            return activeSessionId;
        return recentUserText.size === 0 ? undefined : [...recentUserText.keys()].at(-1);
    }
    // ── 5. 技能 provider（目录实时过滤器：enabled && !globalInject 才可能进目录） ─
    const skills = ctx.skills;
    ctx.effect(() => skills.registerProvider(() => ({
        name: PROVIDER_NAME,
        async list() {
            const all = loadSkills();
            const st = safeSettings();
            const sessionText = latestUserText();
            const hits = sessionText ? matchSkills(sessionText, all) : [];
            const visible = all.filter((s) => {
                const c = skillConfigOf(st, s.name);
                if (!c.enabled)
                    return false;
                if (c.globalInject)
                    return false; // 全局注入的走 assemble，不进目录
                if (c.mode === 'auto')
                    return true; // 自动模式全量暴露，模型自主选择
                return hits.includes(s); // 手动模式：仅命中才暴露
            });
            if (sticky && visible.length === 0) {
                // 未命中但允许粘连：沿用上一次命中的技能（当前 session）
                const prev = lastHits.get(currentSessionId() ?? '') ?? [];
                if (prev.length) {
                    return { candidates: prev.map((n) => candidateOf(all.find((s) => s.name === n))).filter(Boolean), complete: false };
                }
            }
            lastHits.set(currentSessionId() ?? '', visible.map((s) => s.name));
            return { candidates: visible.map((s) => candidateOf(s)).filter(Boolean), complete: false };
        },
        async get(candidate) {
            const all = loadSkills();
            const skill = all.find((s) => s.name === candidate.name);
            if (!skill)
                return undefined;
            return definitionOf(skill);
        },
    })), '@dsh-external/dsh-skill-scheduler: skill provider');
    function candidateOf(skill) {
        return {
            name: skill.name,
            description: skill.description,
            invocation: { modelInvocable: true, userInvocable: true },
            source: 'bundled',
            provider: PROVIDER_NAME,
            resourceBase: { kind: 'directory', path: dirname(skill.path) },
            rank: PROVIDER_RANK,
            locator: skill.path,
            path: skill.path,
        };
    }
    function definitionOf(skill) {
        return {
            ...candidateOf(skill),
            content: skill.content,
        };
    }
    // ── 6. 全局注入 + 调度引导（每次生成注入系统提示） ────────────────────────
    // 与 dsh-skill 的 renderSkillContent 同构（escapeAttr/escapeText 最小实现，
    // 避免运行时 import @deepseek-ai/dsh-skill 增加耦合；输出格式完全一致）。
    const escapeAttr = (v) => v.replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;');
    const escapeText = (v) => v.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
    function renderSkillContentOf(s) {
        return [
            `<skill_content name="${escapeAttr(s.name)}">`,
            '<skill_resources>',
            `Base directory for this skill: ${escapeText(dirname(s.path))}`,
            'Resolve relative paths mentioned by this skill against the base directory before using them. Load referenced resources only as needed.',
            '</skill_resources>',
            '',
            '<skill_instructions>',
            s.content,
            '</skill_instructions>',
            '</skill_content>',
        ].join('\n');
    }
    /**
     * 调度引导（开头注入）：告诉 AI 如何自动调用 skill——何时调、怎么调、
     * 点名必用、全局注入的直接遵循。技能清单（name + 用途）由 dsh-tool-skill
     * 的 available_skills 目录消息提供，此处只讲规则、不重复列描述。
     */
    function renderSchedulerGuide(st, all, recentText) {
        const hits = recentText ? matchSkills(recentText, all) : [];
        const manualHit = all.filter((s) => {
            const c = skillConfigOf(st, s.name);
            return c.enabled && !c.globalInject && c.mode === 'manual' && hits.includes(s);
        });
        const injected = all.filter((s) => {
            const c = skillConfigOf(st, s.name);
            return c.enabled && c.globalInject;
        });
        const lines = [
            '<skill_scheduler_guide>',
            '本环境配备按需技能（skill）。当用户请求与技能用途匹配时，调用 skill 工具并传入技能 name，加载全文后严格按技能内指示执行（例如按指定视觉风格生成页面/组件）；若用户点名某技能（如“毛玻璃”“赛博朋克”），必须使用该技能。',
            '可用技能清单见系统提示中的技能目录（available_skills，含 name 与用途）。自动模式技能可随时按需选用；手动模式技能仅当用户明确提到相关用途时才使用。同一任务只选择一个最匹配的技能，不要组合多个设计技能。',
        ];
        if (manualHit.length > 0) {
            lines.push(`当前用户消息命中以下手动模式技能，应优先使用：${manualHit.map((s) => s.name).join(', ')}。`);
        }
        if (injected.length > 0) {
            lines.push(`以下技能已注入全文，直接遵循、无需再调用工具：${injected.map((s) => s.name).join(', ')}。`);
        }
        lines.push('</skill_scheduler_guide>');
        return lines.join('\n');
    }
    ;
    ctx.on('system-prompt/assemble', (assembly, context, next) => {
        const sessionId = context?.agent?.session?.id;
        if (typeof sessionId === 'string')
            activeSessionId = sessionId;
        let injects = [];
        let guide;
        try {
            const st = safeSettings();
            const all = loadSkills();
            injects = all.filter((s) => {
                const c = skillConfigOf(st, s.name);
                return c.enabled && c.globalInject;
            });
            guide = all.some((s) => skillConfigOf(st, s.name).enabled) ? renderSchedulerGuide(st, all, latestUserText()) : undefined;
        }
        catch {
            /* 注入失败不应阻断系统提示组装 */
        }
        if (injects.length === 0 && !guide)
            return next();
        const sections = Array.isArray(assembly?.sections) ? [...assembly.sections] : [];
        if (guide)
            sections.unshift({ name: 'skill-scheduler-guide', order: 0, text: guide });
        for (const s of injects) {
            sections.push({ name: `skill-inject:${s.name}`, order: 1000, text: renderSkillContentOf(s) });
        }
        return next({ ...assembly, sections });
    });
    // ── 7. 用户消息监听：session/event 记录文本（assemble 活动会话在 6 中记录） ─
    installMessageListener(ctx, recentUserText);
    // ── 8. 设置页 HTTP 路由（client 半 UI 读写配置） ──────────────────────────
    if (webServer) {
        const isLoopbackHost = (h) => h === '127.0.0.1' || h === '::1' || h === '[::1]' || h === 'localhost';
        const trusted = (req) => {
            const host = req.headers && req.headers.host;
            if (typeof host !== 'string' || host === '')
                return false;
            let hu;
            try {
                hu = new URL('http://' + host);
            }
            catch {
                return false;
            }
            if (!isLoopbackHost(hu.hostname))
                return false;
            if (req.headers && req.headers['sec-fetch-site'] === 'cross-site')
                return false;
            const origin = req.headers && req.headers.origin;
            if (origin === undefined)
                return true; // non-browser client (curl / harness tool)
            try {
                return new URL(origin).host === hu.host;
            }
            catch {
                return false;
            }
        };
        const send = (res, code, body) => {
            res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' });
            res.end(JSON.stringify(body));
        };
        const readBody = (req) => new Promise((resolve, reject) => {
            let data = '';
            req.on('data', (c) => {
                data += c;
                if (data.length > 1e6) {
                    req.destroy();
                    reject(new Error('body too large'));
                }
            });
            req.on('end', () => {
                try {
                    resolve(data ? JSON.parse(data) : {});
                }
                catch (e) {
                    reject(e);
                }
            });
            req.on('error', reject);
        });
        const route = (path, handler) => ctx.effect(() => webServer.register({
            kind: 'exact',
            path,
            handler: (req, res) => {
                if (!trusted(req)) {
                    res.writeHead(403, { 'content-type': 'application/json' });
                    res.end(JSON.stringify({ ok: false, error: 'cross-origin request rejected' }));
                    return;
                }
                return handler(req, res);
            },
        }));
        // GET /skill-scheduler/catalog → { ok, defaultMode, skills: [...] }
        route('/skill-scheduler/catalog', async (_req, res) => {
            try {
                const st = safeSettings();
                const skills = loadSkills().map((s) => {
                    const c = skillConfigOf(st, s.name);
                    return {
                        name: s.name,
                        description: s.description,
                        whenToUse: s.whenToUse ?? '',
                        package: s.package,
                        path: s.path,
                        enabled: c.enabled,
                        globalInject: c.globalInject,
                        mode: c.mode,
                    };
                });
                send(res, 200, { ok: true, defaultMode: st.defaultMode ?? 'auto', skills });
            }
            catch (e) {
                send(res, 500, { ok: false, error: String((e && e.message) || e) });
            }
        });
        // POST /skill-scheduler/config → body { defaultMode?, skills? }
        route('/skill-scheduler/config', async (req, res) => {
            try {
                const body = await readBody(req);
                const patch = {};
                if (body && (body.defaultMode === 'auto' || body.defaultMode === 'manual'))
                    patch.defaultMode = body.defaultMode;
                if (body && body.skills && typeof body.skills === 'object') {
                    const st = safeSettings();
                    const merged = { ...(st.skills ?? {}) };
                    for (const [k, v] of Object.entries(body.skills)) {
                        if (!v || typeof v !== 'object')
                            continue;
                        merged[k] = { ...(merged[k] ?? {}), ...v };
                    }
                    patch.skills = merged;
                }
                if (Object.keys(patch).length === 0)
                    return send(res, 200, { ok: true });
                await settingsController.update(patch);
                send(res, 200, { ok: true });
            }
            catch (e) {
                send(res, 500, { ok: false, error: String((e && e.message) || e) });
            }
        });
    }
    ctx.logger.info(`[skill-scheduler] 就绪，托管 ${loadSkills().length} 个技能（自动发现 + 配置合并）`);
}
// ── 用户消息监听 ──────────────────────────────────────────────────────────
/**
 * 1) `session/event`（type=user/message）把每条用户消息文本写入
 *    recentUserText（sessionId → 最近一条文本，Map 保留最近 MAX_SESSIONS 条）。
 * 2) `system-prompt/assemble` 记录"正在处理请求的会话 id"（Waterfall，必须
 *    调用 next() 放行，否则会短路系统提示组装）——v0.2 起活动会话记录移入
 *    apply 内的全局注入 listener（同一事件第二个监听器），此处不再重复挂。
 */
function installMessageListener(ctx, recentUserText) {
    const MAX_SESSIONS = 64;
    const push = (sessionId, text) => {
        recentUserText.set(sessionId, text);
        while (recentUserText.size > MAX_SESSIONS) {
            const oldest = recentUserText.keys().next().value;
            if (oldest === undefined)
                break;
            recentUserText.delete(oldest);
        }
    };
    ctx.on('session/event', (session, event) => {
        if (event?.type !== 'user/message')
            return;
        const message = event.data?.message;
        if (!message?.content)
            return;
        const text = extractUserText(message);
        if (text)
            push(session?.id ?? 'default', text);
    });
}
/** 从一条 role=user 的 message 里提取纯文本（取最后一个 text 块） */
function extractUserText(message) {
    if (!Array.isArray(message.content))
        return undefined;
    let last;
    for (const block of message.content) {
        if (block && typeof block === 'object' && block.type === 'text' && typeof block.text === 'string' && block.text.trim()) {
            last = block.text;
        }
    }
    return last?.trim();
}
// ── frontmatter 解析（与 dsh-design-skills 相同语义） ─────────────────────
function parseFrontmatter(raw) {
    const firstLineEnd = raw.indexOf('\n');
    if (firstLineEnd < 0)
        return undefined;
    if (raw.slice(0, firstLineEnd).replace(/\r$/, '') !== '---')
        return undefined;
    const start = firstLineEnd + 1;
    const closing = findClosingFrontmatter(raw, start);
    if (!closing)
        return undefined;
    const data = parseFrontmatterLines(raw.slice(start, closing.start));
    if (!data)
        return undefined;
    return { data, body: raw.slice(closing.bodyStart) };
}
/** 轻量 frontmatter 行解析：仅处理单行裸标量（name/description/whenToUse 即此形态），值以引号首尾包裹时剥引号。 */
function parseFrontmatterLines(body) {
    const out = {};
    for (const line of body.split(/\r?\n/)) {
        const m = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line);
        if (!m)
            continue;
        const key = m[1];
        let val = m[2].trim();
        if (val.length >= 2 &&
            ((val[0] === '"' && val[val.length - 1] === '"') || (val[0] === "'" && val[val.length - 1] === "'"))) {
            val = val.slice(1, -1);
        }
        if (val)
            out[key] = val;
    }
    return Object.keys(out).length > 0 ? out : undefined;
}
function findClosingFrontmatter(raw, start) {
    let lineStart = start;
    while (lineStart <= raw.length) {
        const nextNewline = raw.indexOf('\n', lineStart);
        const lineEnd = nextNewline < 0 ? raw.length : nextNewline;
        if (raw.slice(lineStart, lineEnd).replace(/\r$/, '') === '---') {
            return { start: lineStart, bodyStart: nextNewline < 0 ? raw.length : nextNewline + 1 };
        }
        if (nextNewline < 0)
            return undefined;
        lineStart = nextNewline + 1;
    }
    return undefined;
}
//# sourceMappingURL=index.js.map