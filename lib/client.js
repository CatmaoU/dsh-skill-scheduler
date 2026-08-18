window.__ModuleLoader__.load({
	id: "@dsh-external/dsh-skill-scheduler",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		var React = require("react");
		const h = React.createElement;

		const CSS = `
.dsh-skill-scheduler-row { padding: 2px 0 6px; color: var(--dsw-alias-label-primary, #16181d); }
.dsh-skill-scheduler-title { font-size: 14px; font-weight: 600; margin: 0 0 4px; }
.dsh-skill-scheduler-summary { font-size: 12px; opacity: 0.75; margin: 0 0 10px; line-height: 1.5; }
.dsh-skill-scheduler-hint { font-size: 12px; opacity: 0.6; margin: 6px 0 10px; line-height: 1.5; }
.dsh-skill-scheduler-default { display: flex; align-items: center; gap: 8px; margin: 8px 0 4px; font-size: 13px; }
.dsh-skill-scheduler-default select,
.dsh-skill-scheduler-mode select {
  background: color-mix(in srgb, var(--dsw-alias-bg-base, #fff) 92%, transparent);
  color: var(--dsw-alias-label-primary, #16181d);
  border: 1px solid color-mix(in srgb, var(--dsw-alias-label-primary, #16181d) 22%, transparent);
  border-radius: 8px; padding: 3px 8px; font-size: 12px;
}
.dsh-skill-scheduler-list { display: flex; flex-direction: column; gap: 8px; margin-top: 10px; }
.dsh-skill-scheduler-card {
  border: 1px solid color-mix(in srgb, var(--dsw-alias-label-primary, #16181d) 14%, transparent);
  border-radius: 10px; padding: 8px 10px;
  background: color-mix(in srgb, var(--dsw-alias-bg-base, #fff) 70%, transparent);
}
.dsh-skill-scheduler-card-head { display: flex; align-items: baseline; gap: 8px; }
.dsh-skill-scheduler-name { font-weight: 600; font-size: 13px; font-family: ui-monospace, "Cascadia Mono", Consolas, monospace; }
.dsh-skill-scheduler-pkg {
  font-size: 10px; opacity: 0.55; font-family: ui-monospace, "Cascadia Mono", Consolas, monospace;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 220px;
}
.dsh-skill-scheduler-desc {
  font-size: 12px; opacity: 0.8; margin: 4px 0 6px; line-height: 1.45;
  display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden;
}
.dsh-skill-scheduler-ctrls { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; font-size: 12px; }
.dsh-skill-scheduler-toggle { display: inline-flex; align-items: center; gap: 4px; cursor: pointer; user-select: none; }
.dsh-skill-scheduler-toggle input { accent-color: var(--dsw-alias-brand, #4d6bfe); cursor: pointer; }
.dsh-skill-scheduler-mode { display: inline-flex; align-items: center; gap: 4px; }
.dsh-skill-scheduler-status { font-size: 12px; margin: 8px 0 0; opacity: 0.8; }
.dsh-skill-scheduler-status-ok { color: #2f9e44; }
.dsh-skill-scheduler-status-err { color: #e03131; }
`;

		function injectCss(css) {
			const el = document.createElement("style");
			el.textContent = css;
			el.setAttribute("data-dsh-skill-scheduler", "1");
			document.head.appendChild(el);
		}

		const MODE_LABELS = { auto: "自动（AI 自主选择）", manual: "手动（仅点名/触发）" };

		function SkillRow(props) {
			const skill = props.skill;
			const patch = (p) => props.onPatch(skill.name, p);
			return h("div", { className: "dsh-skill-scheduler-card" }, [
				h("div", { key: "head", className: "dsh-skill-scheduler-card-head" }, [
					h("span", { key: "n", className: "dsh-skill-scheduler-name" }, skill.name),
					h("span", { key: "p", className: "dsh-skill-scheduler-pkg", title: skill.package }, skill.package),
				]),
				h("div", { key: "desc", className: "dsh-skill-scheduler-desc", title: skill.description }, skill.description),
				h("div", { key: "ctrls", className: "dsh-skill-scheduler-ctrls" }, [
					h("label", { key: "en", className: "dsh-skill-scheduler-toggle" }, [
						h("input", { type: "checkbox", checked: !!skill.enabled, onChange: (e) => patch({ enabled: e.target.checked }) }),
						h("span", null, "启用"),
					]),
					h("label", { key: "gi", className: "dsh-skill-scheduler-toggle" }, [
						h("input", { type: "checkbox", checked: !!skill.globalInject, onChange: (e) => patch({ globalInject: e.target.checked }) }),
						h("span", null, "全局注入"),
					]),
					h("label", { key: "md", className: "dsh-skill-scheduler-mode" }, [
						h("span", null, "模式"),
						h("select", { value: skill.mode, onChange: (e) => patch({ mode: e.target.value }) },
							Object.keys(MODE_LABELS).map((m) => h("option", { key: m, value: m }, MODE_LABELS[m]))),
					]),
				]),
			]);
		}

		function SkillSchedulerSettings() {
			const [state, setState] = React.useState(null); // null | { defaultMode, skills: [] }
			const [busy, setBusy] = React.useState(false);
			const [status, setStatus] = React.useState(""); // "" | saved | error
			const [error, setError] = React.useState("");

			React.useEffect(() => {
				let alive = true;
				fetch("/skill-scheduler/catalog")
					.then((r) => r.json())
					.then((d) => {
						if (alive && d && d.ok) setState({ defaultMode: d.defaultMode, skills: d.skills });
					})
					.catch(() => {});
				return () => { alive = false; };
			}, []);

			const persist = (next) => {
				setState(next);
				setStatus("");
				setError("");
				const body = { defaultMode: next.defaultMode, skills: {} };
				for (const s of next.skills) body.skills[s.name] = { enabled: s.enabled, globalInject: s.globalInject, mode: s.mode };
				setBusy(true);
				fetch("/skill-scheduler/config", {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify(body),
				})
					.then((r) => r.json())
					.then((d) => {
						setBusy(false);
						if (d && d.ok) setStatus("saved");
						else { setStatus("error"); setError((d && d.error) || "保存失败"); }
					})
					.catch(() => { setBusy(false); setStatus("error"); setError("保存失败（网络错误）"); });
			};

			if (state === null) {
				return h("div", { className: "dsh-skill-scheduler-row" }, "加载技能列表…");
			}

			const setDefaultMode = (e) => persist(Object.assign({}, state, { defaultMode: e.target.value }));
			const patchSkill = (name, p) => {
				const skills = state.skills.map((s) => (s.name === name ? Object.assign({}, s, p) : s));
				persist(Object.assign({}, state, { skills }));
			};

			const enabledCount = state.skills.filter((s) => s.enabled).length;
			const statusNode = busy
				? h("p", { key: "busy", className: "dsh-skill-scheduler-status" }, "保存中…")
				: status === "saved"
					? h("p", { key: "ok", className: "dsh-skill-scheduler-status dsh-skill-scheduler-status-ok" }, "已保存 ✓")
					: status === "error"
						? h("p", { key: "err", className: "dsh-skill-scheduler-status dsh-skill-scheduler-status-err" }, "✗ " + error)
						: null;

			return h("div", { className: "dsh-skill-scheduler-row" }, [
				h("h2", { key: "t", className: "dsh-skill-scheduler-title" }, "Skill 调度器"),
				h("p", { key: "sum", className: "dsh-skill-scheduler-summary" },
					"共发现 " + String(state.skills.length) + " 个技能（" + String(enabledCount) + " 个启用）。新增带 skills/ 目录的插件后自动读取。"),
				h("div", { key: "dm", className: "dsh-skill-scheduler-default" }, [
					h("span", { key: "l" }, "默认调用模式"),
					h("select", { key: "s", value: state.defaultMode, onChange: setDefaultMode },
						Object.keys(MODE_LABELS).map((m) => h("option", { key: m, value: m }, MODE_LABELS[m]))),
				]),
				h("p", { key: "dmhint", className: "dsh-skill-scheduler-hint" },
					"自动：技能始终可供 AI 根据你的回答自主选用；手动：仅当你说到技能名/触发词时才启用。自动模式下点名技能（如说“毛玻璃”）同样生效。"),
				h("div", { key: "list", className: "dsh-skill-scheduler-list" },
					state.skills.map((s) => h(SkillRow, { key: s.name, skill: s, onPatch: patchSkill }))),
				statusNode,
			]);
		}

		function apply(ctx) {
			const slots = ctx.get("slots");
			if (slots === undefined) return;
			ctx.effect(() => injectCss(CSS));
			ctx.slots.inject("settings.section", () => ctx.slots.register({
				name: "settings.section",
				id: "dsh-skill-scheduler",
				order: 80,
				label: "Skill 调度器",
			}, SkillSchedulerSettings));
		}

		exports.name = "@dsh-external/dsh-skill-scheduler";
		exports.inject = ["slots"];
		exports.apply = apply;
		return module.exports;
	}
});
