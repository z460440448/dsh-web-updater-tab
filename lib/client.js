/**
 * dsh-web-updater 客户端半个插件。
 *
 * 两件事：
 * 1) 把挂件 UI 的运行时脚本注入页面（真正的界面在 /dsh-updater/ui.js，no-store，
 *    所以改样式/交互只需刷新页面）。
 * 2) 在「设置」里注册一节 DSH 更新：显示/隐藏挂件、自动更新开关、样式（配色）。
 */
window.__ModuleLoader__.load({
	id: "dsh-web-updater",
	factory: function (require) {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

		const React = require("react");
		const SCRIPT_ID = "dsh-web-updater-boot";
		const HIDDEN_KEY = "dsh-web-updater:hidden";
		const THEME_KEY = "dsh-web-updater:theme";

		// ── 挂件引导 ──────────────────────────────────────────────
		function mountUi() {
			if (document.getElementById(SCRIPT_ID)) return;
			const script = document.createElement("script");
			script.id = SCRIPT_ID;
			script.async = true;
			script.src = "/dsh-updater/ui.js?v=" + Date.now();
			script.onerror = function () {
				console.warn("[dsh-web-updater] 加载 /dsh-updater/ui.js 失败");
			};
			document.head.append(script);
		}

		function readFlag(key, fallback) {
			try { return localStorage.getItem(key) ?? fallback } catch { return fallback }
		}
		function writeFlag(key, value) {
			try { value === null ? localStorage.removeItem(key) : localStorage.setItem(key, value) } catch {}
		}
		function notifyWidget() {
			try { window.dispatchEvent(new CustomEvent("dsh-updater:settings-changed")) } catch {}
		}

		// ── 设置页 ────────────────────────────────────────────────
		const THEMES = [["auto", "跟随系统"], ["light", "浅色"], ["dark", "深色"], ["amber", "琥珀"]];

		const styles = {
			wrap: { padding: "4px 2px", color: "inherit" },
			row: {
				display: "flex", alignItems: "center", justifyContent: "space-between", gap: "24px",
				padding: "15px 0", borderBottom: "1px solid rgba(127,127,127,.22)",
			},
			rowLast: { display: "flex", alignItems: "center", justifyContent: "space-between", gap: "24px", padding: "15px 0" },
			label: { fontWeight: 600, fontSize: "14px", lineHeight: 1.45 },
			hint: { opacity: 0.6, fontSize: "12.5px", lineHeight: 1.5, marginTop: "2px", maxWidth: "440px" },
			selectSmall: {
				padding: "5px 8px", borderRadius: "8px", border: "1px solid rgba(127,127,127,.35)",
				background: "transparent", color: "inherit", fontSize: "13px", font: "inherit",
			},
			select: {
				padding: "6px 10px", borderRadius: "8px", border: "1px solid rgba(127,127,127,.35)",
				background: "transparent", color: "inherit", fontSize: "13px", font: "inherit",
			},
			checkbox: { width: "18px", height: "18px", accentColor: "#2f6fed", cursor: "pointer" },
			value: { fontVariantNumeric: "tabular-nums", fontSize: "13px", opacity: 0.85, whiteSpace: "nowrap" },
			error: { color: "#e5484d", fontSize: "12.5px", marginTop: "10px" },
		};

		function Row(props) {
			return React.createElement(
				"div",
				{ style: props.last ? styles.rowLast : styles.row },
				React.createElement(
					"div",
					{ style: { minWidth: 0 } },
					React.createElement("div", { style: styles.label }, props.label),
					props.hint ? React.createElement("div", { style: styles.hint }, props.hint) : null,
				),
				props.children,
			);
		}

		function UpdaterSettings() {
			const [status, setStatus] = React.useState(null);
			const [hidden, setHidden] = React.useState(() => readFlag(HIDDEN_KEY, "") === "1");
			const [theme, setTheme] = React.useState(() => readFlag(THEME_KEY, "auto") || "auto");
			const [saving, setSaving] = React.useState(false);
			const [error, setError] = React.useState("");

			React.useEffect(() => {
				let alive = true;
				fetch("/dsh-updater/status", { cache: "no-store", credentials: "same-origin" })
					.then((res) => res.json())
					.then((body) => { if (alive) setStatus(body) })
					.catch((err) => { if (alive) setError(String((err && err.message) || err)) });
				return () => { alive = false };
			}, []);

			function toggleHidden(next) {
				writeFlag(HIDDEN_KEY, next ? "1" : null);
				setHidden(next);
				notifyWidget();
			}
			function chooseTheme(next) {
				writeFlag(THEME_KEY, next === "auto" ? null : next);
				setTheme(next);
				notifyWidget();
			}
			function saveConfig(patch) {
				setSaving(true);
				setError("");
				return fetch("/dsh-updater/config", {
					method: "POST",
					credentials: "same-origin",
					headers: { "content-type": "application/json" },
					body: JSON.stringify(patch),
				})
					.then((res) => res.json().then((body) => ({ ok: res.ok, body })))
					.then(({ ok, body }) => {
						if (!ok) throw new Error((body && body.error) || "保存失败");
						setStatus((prev) => ({ ...(prev || {}), ...patch }));
					})
					.catch((err) => setError(String((err && err.message) || err)))
					.finally(() => setSaving(false));
			}

			function toggleAuto(next) {
				saveConfig({ autoApply: next });
			}

			function setQuiet(nextFrom, nextTo) {
				// 起点终点不能相同（否则等于没有静默时段）
				if (nextFrom === nextTo) nextTo = (nextFrom + 1) % 24;
				saveConfig({ quietHours: [nextFrom, nextTo] });
			}

			function body() {
				const autoApply = status ? status.autoApply !== false : true;
				const quiet = status && Array.isArray(status.quietHours) && status.quietHours.length === 2 ? status.quietHours : [3, 6];
				const quietFrom = Number(quiet[0]);
				const quietTo = Number(quiet[1]);
				return React.createElement(
					"div",
					{ style: styles.wrap },
					React.createElement(
						Row,
						{ label: "显示更新挂件", hint: "关掉后页面上的竖直标签完全隐藏；把鼠标移到屏幕对应侧边，或访问 ?dshUpdater=show 可恢复。" },
						React.createElement("input", {
							type: "checkbox", style: styles.checkbox, checked: !hidden,
							"aria-label": "显示更新挂件",
							onChange: (event) => toggleHidden(!event.target.checked),
						}),
					),
					React.createElement(
						Row,
						{ label: "自动更新", hint: "开启后由后台任务在静默时段自动安装新版并重启；关闭则只提醒。" },
						React.createElement("input", {
							type: "checkbox", style: styles.checkbox, checked: autoApply, disabled: saving,
							"aria-label": "自动更新",
							onChange: (event) => toggleAuto(event.target.checked),
						}),
					),
					React.createElement(
						Row,
						{ label: "自动更新时段", hint: "只在此时段内（且 15 分钟没有会话写入）才自动安装；可以跨夜，例如 22 点到 6 点。" },
						React.createElement(
							"div",
							{ style: { display: "flex", alignItems: "center", gap: "8px", opacity: autoApply ? 1 : 0.45 } },
							React.createElement(
								"select",
								{
									style: styles.selectSmall, value: String(quietFrom), disabled: !autoApply || saving,
									"aria-label": "自动更新时段开始",
									onChange: (event) => setQuiet(Number(event.target.value), quietTo),
								},
								...Array.from({ length: 24 }, (_, hour) =>
									React.createElement("option", { key: hour, value: String(hour) }, String(hour).padStart(2, "0") + ":00")),
							),
							React.createElement("span", { style: { opacity: 0.6, fontSize: "12.5px" } }, "至"),
							React.createElement(
								"select",
								{
									style: styles.selectSmall, value: String(quietTo), disabled: !autoApply || saving,
									"aria-label": "自动更新时段结束",
									onChange: (event) => setQuiet(quietFrom, Number(event.target.value)),
								},
								...Array.from({ length: 24 }, (_, hour) =>
									React.createElement("option", { key: hour, value: String(hour) }, String(hour).padStart(2, "0") + ":00")),
							),
						),
					),
					React.createElement(
						Row,
						{ label: "挂件样式", hint: "挂件与详情浮层的配色。跟随系统会随浅色/深色模式自动切换。" },
						React.createElement(
							"select",
							{ style: styles.select, value: theme, onChange: (event) => chooseTheme(event.target.value) },
							...THEMES.map(([value, label]) => React.createElement("option", { key: value, value }, label)),
						),
					),
					React.createElement(
						Row,
						{ label: "版本", last: true, hint: status && status.checkedAt ? "上次检查：" + new Date(status.checkedAt).toLocaleString() : "尚未检查" },
						React.createElement(
							"div",
							{ style: styles.value },
							status
								? (status.installed || "—") + (status.updateAvailable && status.latest ? " → " + status.latest : "（已是最新）")
								: "读取中…",
						),
					),
					error ? React.createElement("div", { style: styles.error }, error) : null,
				);
			}

			try {
				return body();
			} catch (err) {
				console.error("[dsh-web-updater] settings render failed", err);
				return React.createElement("div", { style: styles.wrap }, "DSH 更新设置加载失败：" + String((err && err.message) || err));
			}
		}

		// ── 插件入口 ──────────────────────────────────────────────
		function apply(ctx) {
			try {
				if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", mountUi, { once: true });
				else mountUi();
			} catch (err) {
				console.error("[dsh-web-updater] mount ui failed", err);
			}
			try {
				if (ctx && ctx.slots && typeof ctx.slots.inject === "function") {
					ctx.slots.inject("settings.section", () =>
						ctx.slots.register({ name: "settings.section", id: "dsh-updater", order: 30, label: () => "DSH 更新" }, UpdaterSettings),
					);
				}
			} catch (err) {
				console.error("[dsh-web-updater] settings section registration failed", err);
			}
		}

		exports.inject = ["slots"];
		exports.apply = apply;
		return module.exports;
	}
});
