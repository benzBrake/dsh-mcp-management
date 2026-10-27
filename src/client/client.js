/**
 * dsh-mcp-management — 浏览器端（设置 → MCP）。
 *
 * 这份文件是**单文件** ModuleLoader 模块：宿主只按 package.json 的
 * exports["./client"] 取一个脚本地址，没有打包步骤，所以不能拆成多个文件 import。
 * 改的时候按下面的段落找，别改变缩进风格（tab）与工厂函数签名。
 *
 *   1. rpc        调用 /api/mcp-management，把 envelope 还原成异常
 *   2. locale     zh / en 文案表
 *   3. styles     注入一次 <style id="dsh-mcp-management-styles">
 *   4. helpers    args / env / headers 的文本 ↔ 结构互转
 *   5. form       单台服务器的编辑表单
 *   6. import     粘贴别人给的 MCP JSON（预览走 dryRun，导入走同名覆盖开关）
 *   7. panel      一个作用域（全局 / 项目）的列表与操作
 *   8. section    整个设置页签：tab、项目目录选择、旧条目迁移提示
 *   9. plugin     ctx.slots 注册到 settings.section（order 19）
 *  10. navMark    设置导航里本页那颗图标的补丁（宿主只认硬编码 id，slot 不收图标）
 */

window.__ModuleLoader__.load({
	id: "dsh-mcp-management",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		"use strict";

		var React = require("react");
		var h = React.createElement;
		var useState = React.useState;
		var useEffect = React.useEffect;
		var useCallback = React.useCallback;

		// ── rpc ────────────────────────────────────────────────────────────────
		var CHANNEL = "/api";
		var PREFIX = "mcp-management";

		function RpcError(error) {
			var err = new Error(error.code + ": " + error.message);
			err.name = "McpPresetsRpcError";
			err.code = error.code;
			err.fields = error.details && error.details.fields ? error.details.fields : undefined;
			err.details = error.details;
			return err;
		}

		async function callRpc(ctx, action, data) {
			var connection = ctx.connection;
			if (connection === undefined) throw new Error("connection service unavailable");
			var raw = await connection.rpc.call(CHANNEL, PREFIX, {
				action: action,
				data: data === undefined ? null : data,
			});
			if (raw && raw.ok) return raw.value;
			throw RpcError((raw && raw.error) || { code: "internal", message: "empty response" });
		}

		function errorMessage(err) {
			if (err && err.name === "McpPresetsRpcError") return err.message;
			return err instanceof Error ? err.message : String(err);
		}

		// ── locale ─────────────────────────────────────────────────────────────
		var NS = "mcpManagement";
		var zh = {
			nav: "MCP",
			title: "MCP 管理",
			intro: "全局 MCP 任何项目都能用；项目 MCP 只属于某一个工作目录，打开那个目录的会话才会看见。改完立即生效，不用新建会话。",
			tabGlobal: "全局",
			tabProject: "项目",
			globalHint: "写到 profile 的 mcp.yml，所有项目、所有会话共用。",
			projectHint: "写到项目里的 .dsh/mcp.yml，只在这个目录的会话里出现。",
			file: "文件",
			statusOk: "正常",
			statusMissing: "文件不存在",
			statusEmpty: "空白文件",
			statusInvalid: "文件损坏",
			refresh: "刷新",
			reload: "重新加载",
			add: "添加 MCP",
			createFile: "创建文件",
			noServers: "还没有 MCP 服务器。",
			missingHint: "这个文件还不存在。第一次添加 MCP（或点「创建文件」）时会自动建好。",
			emptyHint: "文件存在但是空的，往里加一台 MCP 就行。",
			invalidHint: "这个文件解析不了，里面的 MCP 没有挂载。修好文件后点「重新加载」；也可以直接用覆盖写入重建。",
			overwrite: "覆盖重建",
			connectedAgents: "{mounted} 个会话已挂载",
			agentsHint: "当前共 {agents} 个会话看到这份配置",
			mountError: "挂载失败：{error}",
			projectDir: "项目目录",
			projectDirPlaceholder: "D:\\work\\my-project",
			useCurrent: "用当前会话目录",
			knownProjects: "已知项目",
			pickProject: "选择已知项目…",
			noProject: "还没有打开过任何项目。可以先填一个绝对路径。",
			name: "名称",
			nameHint: "工具前缀 mcp__<名称>__*，只能用字母数字 _ -",
			transport: "传输方式",
			command: "命令",
			args: "参数（每行一个）",
			cwd: "工作目录",
			url: "URL",
			env: "环境变量（每行 KEY=VALUE）",
			headers: "请求头（每行 Key: Value）",
			timeout: "调用超时（毫秒）",
			enabled: "启用",
			save: "保存",
			cancel: "取消",
			edit: "编辑",
			remove: "删除",
			test: "测试",
			enable: "启用",
			disable: "停用",
			testing: "测试中…",
			okTools: "连通 · {count} 个工具 · {ms} ms",
			probeFailed: "连接失败：{error}",
			loading: "加载中…",
			error: "操作失败",
			off: "已停用",
			emptyName: "名称必填",
			removeConfirm: "删除 MCP「{name}」？",
			legacyTitle: "检测到 {count} 台旧式全局 MCP",
			legacyBody: "cordis.patch.yml 的顶层还挂着：{names}。把它们迁到 mcp.yml 之后，这一个面板就能统一管理。",
			legacyAction: "迁移到 mcp.yml",
			partial: "部分条目被跳过：{text}",
			importJson: "粘贴 JSON 导入",
			importTitle: "从 JSON 导入 MCP",
			importHint: "把别人给的 MCP 配置整段粘进来就行：mcpServers 映射、服务器数组、单台对象、裸名称映射都能认；尾随逗号、代码围栏、整行注释会自动清掉。",
			importPlaceholder: "{\n  \"mcpServers\": {\n    \"ida\": {\n      \"command\": \"D:\\\\tools\\\\ida\\\\idalib-mcp.exe\",\n      \"args\": [\"--stdio\"]\n    }\n  }\n}",
			importChecking: "解析中…",
			importShape: "识别为 {shape}",
			importPreview: "共 {count} 台",
			importSkipDup: "同名已存在，将被跳过：{names}",
			importReplace: "同名覆盖",
			importReplaceHint: "勾上则用 JSON 里的定义替换同名的服务器，不勾则跳过。",
			importDo: "导入",
			importNothing: "还没解析出服务器",
			importDone: "已导入 {count} 台：{names}",
			importDoneSkip: " · 跳过同名 {count} 台",
			importNothingToDo: "没有需要写入的改动",
		};
		var en = {
			nav: "MCP",
			title: "MCP",
			intro: "Global MCP servers work in every project; project servers belong to one working directory and only appear in sessions opened there. Edits apply right away — no new session needed.",
			tabGlobal: "Global",
			tabProject: "Project",
			globalHint: "Stored in the profile's mcp.yml — shared by all projects and sessions.",
			projectHint: "Stored in the project's .dsh/mcp.yml — only visible in sessions of that directory.",
			file: "File",
			statusOk: "OK",
			statusMissing: "missing",
			statusEmpty: "empty",
			statusInvalid: "broken",
			refresh: "Refresh",
			reload: "Reload",
			add: "Add MCP",
			createFile: "Create file",
			noServers: "No MCP server yet.",
			missingHint: "This file does not exist yet. Adding the first server (or “Create file”) writes it.",
			emptyHint: "The file exists but lists no server.",
			invalidHint: "This file does not parse, so its servers are not mounted. Fix it and press “Reload”, or overwrite it with the form.",
			overwrite: "Overwrite",
			connectedAgents: "{mounted} session(s) mounted",
			agentsHint: "{agents} session(s) see this configuration",
			mountError: "Mount failed: {error}",
			projectDir: "Project directory",
			projectDirPlaceholder: "D:\\work\\my-project",
			useCurrent: "Use current session",
			knownProjects: "Known projects",
			pickProject: "Pick a known project…",
			noProject: "No project opened yet — type an absolute path.",
			name: "Name",
			nameHint: "Tool prefix mcp__<name>__*; letters, digits, _ and - only",
			transport: "Transport",
			command: "Command",
			args: "Args (one per line)",
			cwd: "Working dir",
			url: "URL",
			env: "Env (KEY=VALUE per line)",
			headers: "Headers (Key: Value per line)",
			timeout: "Call timeout (ms)",
			enabled: "Enabled",
			save: "Save",
			cancel: "Cancel",
			edit: "Edit",
			remove: "Delete",
			test: "Test",
			enable: "Enable",
			disable: "Disable",
			testing: "Testing…",
			okTools: "Connected · {count} tools · {ms} ms",
			probeFailed: "Connection failed: {error}",
			loading: "Loading…",
			error: "Operation failed",
			off: "Disabled",
			emptyName: "Name is required",
			removeConfirm: "Delete MCP “{name}”?",
			legacyTitle: "{count} legacy global MCP server(s) found",
			legacyBody: "cordis.patch.yml still mounts: {names}. Move them into mcp.yml to manage everything here.",
			legacyAction: "Move to mcp.yml",
			partial: "Skipped: {text}",
			importJson: "Paste JSON",
			importTitle: "Import MCP from JSON",
			importHint: "Paste any MCP config you were given: mcpServers maps, server arrays, a single server object, or a bare name map. Trailing commas, code fences and full-line comments are cleaned up.",
			importPlaceholder: "{\n  \"mcpServers\": {\n    \"ida\": {\n      \"command\": \"D:\\\\tools\\\\ida\\\\idalib-mcp.exe\",\n      \"args\": [\"--stdio\"]\n    }\n  }\n}",
			importChecking: "Parsing…",
			importShape: "Detected {shape}",
			importPreview: "{count} server(s)",
			importSkipDup: "Same name already exists, will be skipped: {names}",
			importReplace: "Replace same name",
			importReplaceHint: "Replaces servers with the same name; otherwise they are skipped.",
			importDo: "Import",
			importNothing: "No server parsed yet",
			importDone: "Imported {count}: {names}",
			importDoneSkip: " · skipped {count} duplicate(s)",
			importNothingToDo: "Nothing to write",
		};

		function format(text, params) {
			if (params === undefined) return text;
			return text.replace(/\{(\w+)\}/g, function (_, key) {
				return params[key] === undefined ? "" : String(params[key]);
			});
		}

		// ── navMark ────────────────────────────────────────────────────────────
		// MCP 官方 mark（modelcontextprotocol.io 的 favicon 图形：三条圆头弧线拼出的 M 形）。
		// 只留描边、去掉官方图里的黑底方块，颜色交给 CSS 的 currentColor。
		var MCP_MARK_SVG =
			'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 180 180" fill="none">' +
			'<g stroke="#000" stroke-width="13" stroke-linecap="round">' +
			'<path d="M23.5996 85.2532L86.2021 22.6507C94.8457 14.0071 108.86 14.0071 117.503 22.6507C126.147 31.2942 126.147 45.3083 117.503 53.9519L70.2254 101.23"/>' +
			'<path d="M70.8789 100.578L117.504 53.952C126.148 45.3083 140.163 45.3083 148.806 53.952L149.132 54.278C157.776 62.9216 157.776 76.9357 149.132 85.5792L92.5139 142.198C89.6327 145.079 89.6327 149.75 92.5139 152.631L104.14 164.257"/>' +
			'<path d="M101.853 38.3013L55.553 84.6011C46.9094 93.2447 46.9094 107.258 55.553 115.902C64.1966 124.546 78.2106 124.546 86.8543 115.902L133.154 69.6025"/>' +
			'</g></svg>';
		var NAV_MARK_URL = 'url("data:image/svg+xml,' + encodeURIComponent(MCP_MARK_SVG) + '")';
		var NAV_ATTR = "data-mcp-nav";
		var NAV_DIALOG = '[data-shortcut-modal="settings"]';

		// ── styles ─────────────────────────────────────────────────────────────
		var STYLE_ID = "dsh-mcp-management-styles";
		var CSS = [
			".mp-root{display:flex;flex-direction:column;gap:14px;font-size:13px;line-height:1.5}",
			".mp-head h2{margin:0 0 6px;font-size:15px;font-weight:600}",
			".mp-head p{margin:0;opacity:.72;max-width:74ch}",
			".mp-bar{display:flex;align-items:center;gap:8px;flex-wrap:wrap}",
			".mp-spacer{flex:1}",
			".mp-tabs{display:inline-flex;gap:2px;padding:2px;border:1px solid rgba(127,127,127,.3);border-radius:8px}",
			".mp-tab{border:0;background:transparent;color:inherit;border-radius:6px;padding:4px 14px;font-size:12px;cursor:pointer;opacity:.72}",
			".mp-tab.on{background:rgba(80,140,255,.16);color:#3b82f6;opacity:1;font-weight:600}",
			".mp-btn{border:1px solid rgba(127,127,127,.35);background:transparent;color:inherit;border-radius:6px;padding:4px 10px;font-size:12px;cursor:pointer;white-space:nowrap}",
			".mp-btn:hover:not(:disabled){background:rgba(127,127,127,.12)}",
			".mp-btn:disabled{opacity:.45;cursor:default}",
			".mp-btn.primary{border-color:rgba(80,140,255,.55);color:#3b82f6}",
			".mp-btn.danger{color:#e5484d;border-color:rgba(229,72,77,.4)}",
			".mp-btn.sm{padding:2px 7px;font-size:11px}",
			".mp-panel{border:1px solid rgba(127,127,127,.25);border-radius:10px;padding:12px;display:flex;flex-direction:column;gap:10px}",
			".mp-file{display:flex;align-items:center;gap:8px;flex-wrap:wrap;font-size:11px;opacity:.78}",
			".mp-path{font-family:ui-monospace,Consolas,monospace;word-break:break-all}",
			".mp-chip{font-size:11px;padding:1px 8px;border-radius:999px;border:1px solid rgba(127,127,127,.35)}",
			".mp-chip.ok{color:#2f9e44;border-color:rgba(47,158,68,.45)}",
			".mp-chip.warn{color:#f08c00;border-color:rgba(240,140,0,.45)}",
			".mp-chip.bad{color:#e5484d;border-color:rgba(229,72,77,.45)}",
			".mp-note{font-size:11px;opacity:.62}",
			".mp-alert{border:1px solid rgba(229,72,77,.4);color:#e5484d;border-radius:8px;padding:8px 10px;font-size:12px;display:flex;flex-direction:column;gap:6px}",
			".mp-warn{border:1px solid rgba(240,140,0,.4);color:#f08c00;border-radius:8px;padding:8px 10px;font-size:12px;display:flex;flex-direction:column;gap:6px}",
			".mp-empty{border:1px dashed rgba(127,127,127,.35);border-radius:8px;padding:14px;text-align:center;font-size:12px;opacity:.7}",
			".mp-server{display:flex;align-items:center;gap:8px;flex-wrap:wrap;padding:7px 9px;border-radius:7px;background:rgba(127,127,127,.07)}",
			".mp-server.off{opacity:.55}",
			".mp-sname{font-family:ui-monospace,Consolas,monospace;font-size:12px;font-weight:600}",
			".mp-pill{font-size:11px;padding:0 6px;border-radius:999px;border:1px solid rgba(127,127,127,.3)}",
			".mp-pill.ok{color:#2f9e44;border-color:rgba(47,158,68,.45)}",
			".mp-pill.bad{color:#e5484d;border-color:rgba(229,72,77,.45)}",
			".mp-target{opacity:.62;font-size:11px;font-family:ui-monospace,Consolas,monospace;word-break:break-all;max-width:46ch}",
			".mp-form{display:grid;grid-template-columns:110px 1fr;gap:7px 10px;align-items:center;border-top:1px solid rgba(127,127,127,.2);padding-top:10px;margin-top:2px}",
			".mp-form label{opacity:.72;font-size:12px}",
			".mp-form input,.mp-form select,.mp-form textarea{width:100%;box-sizing:border-box;background:rgba(127,127,127,.08);border:1px solid rgba(127,127,127,.3);color:inherit;border-radius:5px;padding:3px 6px;font-size:12px;font-family:inherit}",
			".mp-form textarea{min-height:44px;resize:vertical;font-family:ui-monospace,Consolas,monospace}",
			".mp-form .err{grid-column:2;color:#e5484d;font-size:11px}",
			".mp-actions{display:flex;gap:8px;justify-content:flex-end;grid-column:1 / -1}",
			".mp-row{display:flex;gap:8px;align-items:center;flex-wrap:wrap}",
			".mp-import{display:flex;flex-direction:column;gap:9px;border-top:1px solid rgba(127,127,127,.2);padding-top:10px;margin-top:2px}",
			".mp-import textarea{width:100%;box-sizing:border-box;min-height:150px;resize:vertical;font-family:ui-monospace,Consolas,monospace;font-size:12px;line-height:1.45;background:rgba(127,127,127,.08);border:1px solid rgba(127,127,127,.3);color:inherit;border-radius:6px;padding:6px 8px}",
			".mp-import .mp-note{white-space:pre-wrap}",
			".mp-preview{display:flex;flex-direction:column;gap:5px;font-size:11px}",
			".mp-preview .item{font-family:ui-monospace,Consolas,monospace;opacity:.82;word-break:break-all}",
			".mp-check{display:inline-flex;align-items:center;gap:6px;font-size:12px;opacity:.85}",
			// 设置导航：宿主给未知 id 画的是齿轮，这里换成 MCP 官方 mark。
			// 只动 CSS + 一个 data 属性，不往 React 管的节点里插东西（那个会被 re-render 抹掉）。
			"[" + NAV_ATTR + "] > svg{display:none}",
			"[" + NAV_ATTR + "]::before{content:\"\";flex:none;width:16px;height:16px;background-color:currentColor;" +
				"-webkit-mask-image:" + NAV_MARK_URL + ";-webkit-mask-size:contain;-webkit-mask-position:center;-webkit-mask-repeat:no-repeat;" +
				"mask-image:" + NAV_MARK_URL + ";mask-size:contain;mask-position:center;mask-repeat:no-repeat}",
		].join("\n");

		function injectStyles() {
			if (document.getElementById(STYLE_ID) !== null) return;
			var style = document.createElement("style");
			style.id = STYLE_ID;
			style.textContent = CSS;
			document.head.appendChild(style);
		}

		// ── navMark ────────────────────────────────────────────────────────────
		// 宿主 settings-general 的 navIcon(id) 只认 account / models / agent-presets /
		// plugins / archived-sessions 这几个 id，其余（含本面板的 mcp-management）一律回退
		// 到齿轮；settings.section 的注册选项里也没有 icon 字段可传。所以只能等导航渲染出来
		// 后认领本页那颗按钮：打一个 data 属性，CSS 用伪元素画标记、把齿轮藏掉。
		function navLabel(t) {
			try {
				var text = t("nav");
				return typeof text === "string" ? text.trim() : "";
			} catch (error) {
				return "";
			}
		}

		function decorateNav(t) {
			if (typeof document === "undefined" || typeof document.querySelector !== "function") return;
			var dialog = document.querySelector(NAV_DIALOG);
			if (dialog === null || dialog === undefined) return;
			var label = navLabel(t);
			if (label === "") return;
			var buttons = dialog.querySelectorAll("nav button");
			for (var i = 0; i < buttons.length; i++) {
				var button = buttons[i];
				if (button.getAttribute(NAV_ATTR) !== null) continue;
				if (String(button.textContent || "").trim() !== label) continue;
				button.setAttribute(NAV_ATTR, "");
			}
		}

		/**
		 * 盯着 body：设置面板是 portal 出来的，开关一次就重建一次 DOM。
		 * 拿不到 DOM（测试里的假 document）时安静退化成“还是宿主的齿轮”。
		 */
		function watchNav(t) {
			if (typeof document === "undefined" || !document.body) return function () {};
			if (typeof MutationObserver !== "function") return function () {};
			var timer = 0;
			function run() {
				timer = 0;
				decorateNav(t);
			}
			function schedule() {
				if (timer !== 0) return;
				timer = window.setTimeout(run, 40);
			}
			var observer = new MutationObserver(schedule);
			observer.observe(document.body, { childList: true, subtree: true });
			run();
			return function () {
				observer.disconnect();
				if (timer !== 0) window.clearTimeout(timer);
			};
		}

		// ── helpers ────────────────────────────────────────────────────────────
		function linesToArgs(text) {
			return String(text || "")
				.split(/\r?\n/)
				.map(function (x) { return x.trim(); })
				.filter(function (x) { return x !== ""; });
		}

		function linesToMap(text, separator) {
			var out = {};
			String(text || "").split(/\r?\n/).forEach(function (line) {
				var idx = line.indexOf(separator);
				if (idx <= 0) return;
				var key = line.slice(0, idx).trim();
				var value = line.slice(idx + 1).trim();
				if (key !== "") out[key] = value;
			});
			return out;
		}

		function mapToLines(map, separator) {
			if (map === undefined || map === null) return "";
			return Object.keys(map).map(function (k) { return k + separator + map[k]; }).join("\n");
		}

		function targetOf(server) {
			if (server.transport === "stdio") {
				return [server.command || ""].concat(server.args || []).join(" ").trim();
			}
			return server.url || "";
		}

		function statusChipClass(status) {
			if (status === "ok") return "ok";
			if (status === "invalid") return "bad";
			return "warn";
		}

		function statusText(t, status) {
			if (status === "ok") return t("statusOk");
			if (status === "missing") return t("statusMissing");
			if (status === "empty") return t("statusEmpty");
			return t("statusInvalid");
		}

		var LS_KEY = "dsh-mcp-management/project-dir";
		var LS_KEY_LEGACY = "dsh-mcp-presets/project-dir";

		function readStoredDir() {
			try {
				var value = window.localStorage.getItem(LS_KEY) || window.localStorage.getItem(LS_KEY_LEGACY) || "";
				// 改名前的选择搬过来，省得用户重新选一次项目目录
				if (value !== "" && window.localStorage.getItem(LS_KEY) !== value) window.localStorage.setItem(LS_KEY, value);
				return value;
			} catch (error) {
				return "";
			}
		}

		function storeDir(dir) {
			try {
				if (dir) window.localStorage.setItem(LS_KEY, dir);
				else window.localStorage.removeItem(LS_KEY);
				window.localStorage.removeItem(LS_KEY_LEGACY);
			} catch (error) {
				/* ignore */
			}
		}

		// ── server form ────────────────────────────────────────────────────────
		function ServerForm(props) {
			var t = props.t;
			var initial = props.initial || {};
			var [draft, setDraft] = useState(function () {
				return {
					name: initial.name || "",
					transport: initial.transport || "stdio",
					command: initial.command || "",
					args: (initial.args || []).join("\n"),
					cwd: initial.cwd || "",
					url: initial.url || "",
					env: mapToLines(initial.env, "="),
					headers: mapToLines(initial.headers, ": "),
					toolCallTimeoutMs: initial.toolCallTimeoutMs === undefined ? "" : String(initial.toolCallTimeoutMs),
					enabled: initial.enabled === undefined ? true : initial.enabled,
				};
			});
			var [fields, setFields] = useState({});
			var set = function (key) {
				return function (event) {
					var value = event.target.value;
					setDraft(function (prev) {
						var next = Object.assign({}, prev);
						next[key] = value;
						return next;
					});
				};
			};
			var toggleEnabled = function (event) {
				var checked = event.target.checked;
				setDraft(function (prev) {
					var next = Object.assign({}, prev);
					next.enabled = checked;
					return next;
				});
			};
			var submit = function () {
				var localFields = {};
				if (draft.name.trim() === "") localFields.name = t("emptyName");
				if (draft.transport === "stdio" && draft.command.trim() === "") localFields.command = "command required";
				if (draft.transport !== "stdio" && !/^https?:\/\/.+/.test(draft.url.trim())) localFields.url = "http(s) URL required";
				if (Object.keys(localFields).length > 0) {
					setFields(localFields);
					return;
				}
				setFields({});
				var payload = {
					name: draft.name.trim(),
					transport: draft.transport,
					enabled: draft.enabled !== false,
				};
				if (draft.transport === "stdio") {
					payload.command = draft.command.trim();
					var args = linesToArgs(draft.args);
					if (args.length > 0) payload.args = args;
					if (draft.cwd.trim() !== "") payload.cwd = draft.cwd.trim();
				} else {
					payload.url = draft.url.trim();
					var headers = linesToMap(draft.headers, ":");
					if (Object.keys(headers).length > 0) payload.headers = headers;
				}
				var env = linesToMap(draft.env, "=");
				if (Object.keys(env).length > 0) payload.env = env;
				if (draft.toolCallTimeoutMs.trim() !== "") {
					var ms = Number(draft.toolCallTimeoutMs);
					if (Number.isFinite(ms) && ms > 0) payload.toolCallTimeoutMs = ms;
				}
				props.onSubmit(payload, setFields);
			};
			var field = function (name) {
				return fields[name] ? h("div", { className: "err" }, fields[name]) : null;
			};
			return h(
				"div",
				{ className: "mp-form" },
				h("label", null, t("name")),
				h("input", { value: draft.name, onChange: set("name"), placeholder: "ida", title: t("nameHint") }),
				field("name"),
				h("label", null, t("transport")),
				h(
					"select",
					{ value: draft.transport, onChange: set("transport") },
					h("option", { value: "stdio" }, "stdio"),
					h("option", { value: "streamable-http" }, "streamable-http"),
				),
				null,
				draft.transport === "stdio" ? h("label", null, t("command")) : h("label", null, t("url")),
				draft.transport === "stdio"
					? h("input", { value: draft.command, onChange: set("command"), placeholder: "npx -y some-mcp" })
					: h("input", { value: draft.url, onChange: set("url"), placeholder: "http://127.0.0.1:3000/mcp" }),
				draft.transport === "stdio" ? field("command") : field("url"),
				draft.transport === "stdio" ? h("label", null, t("args")) : null,
				draft.transport === "stdio" ? h("textarea", { value: draft.args, onChange: set("args") }) : null,
				draft.transport === "stdio" ? null : null,
				draft.transport === "stdio" ? h("label", null, t("cwd")) : null,
				draft.transport === "stdio"
					? h("input", { value: draft.cwd, onChange: set("cwd"), placeholder: "D:\\work\\proj" })
					: null,
				draft.transport === "stdio" ? null : null,
				h("label", null, t("env")),
				h("textarea", { value: draft.env, onChange: set("env"), placeholder: "TOKEN=xxx" }),
				null,
				draft.transport !== "stdio" ? h("label", null, t("headers")) : null,
				draft.transport !== "stdio" ? h("textarea", { value: draft.headers, onChange: set("headers") }) : null,
				draft.transport !== "stdio" ? null : null,
				h("label", null, t("timeout")),
				h("input", { value: draft.toolCallTimeoutMs, onChange: set("toolCallTimeoutMs"), placeholder: "60000" }),
				null,
				h("label", null, t("enabled")),
				h("input", { type: "checkbox", checked: draft.enabled !== false, onChange: toggleEnabled }),
				null,
				h(
					"div",
					{ className: "mp-actions" },
					h("button", { className: "mp-btn", onClick: props.onCancel }, t("cancel")),
					h("button", { className: "mp-btn primary", onClick: submit }, t("save")),
				),
			);
		}

		// ── json import ────────────────────────────────────────────────────────
		function ImportForm(props) {
			var t = props.t;
			var [text, setText] = useState("");
			var [replace, setReplace] = useState(false);
			var [preview, setPreview] = useState(null);
			var [pending, setPending] = useState(false);

			// 输入停下来 400ms 才去宿主解析：预览和真正导入走同一套解析，不会两处逻辑漂移
			useEffect(
				function () {
					var body = text.trim();
					if (body === "") {
						setPreview(null);
						return undefined;
					}
					var alive = true;
					var timer = setTimeout(function () {
						setPreview({ loading: true });
						props.onPreview(body, replace).then(
							function (value) {
								if (alive) setPreview({ ok: true, value: value });
							},
							function (err) {
								if (alive) setPreview({ ok: false, error: errorMessage(err) });
							},
						);
					}, 400);
					return function () {
						alive = false;
						clearTimeout(timer);
					};
				},
				[text, replace],
			);

			var ready = preview !== null && preview.ok === true && (preview.value.preview || []).length > 0;
			var submit = function () {
				var body = text.trim();
				if (body === "" || pending) return;
				setPending(true);
				props.onImport(body, replace).then(
					function (done) {
						setPending(false);
						if (done) props.onDone();
					},
					function () {
						setPending(false);
					},
				);
			};

			var summary = null;
			if (preview !== null) {
				if (preview.loading === true) {
					summary = h("div", { className: "mp-note" }, t("importChecking"));
				} else if (preview.ok === false) {
					summary = h("div", { className: "mp-alert" }, preview.error);
				} else {
					var value = preview.value;
					var duplicates = (value.skipped || []).map(function (item) { return item.name; });
					summary = h(
						"div",
						{ className: "mp-preview" },
						h(
							"div",
							{ className: "mp-note" },
							t("importShape", { shape: value.shape }) + " · " + t("importPreview", { count: value.preview.length }),
						),
						value.preview.length > 0
							? h(
								"div",
								{ style: { display: "flex", flexDirection: "column", gap: "3px" } },
								value.preview.map(function (server) {
									return h(
										"div",
										{ className: "item", key: server.name },
										"mcp__" + server.name + "__*  ·  " + server.transport + "  ·  " + targetOf(server),
									);
								}),
							)
							: h("div", { className: "mp-note" }, t("importNothing")),
						duplicates.length > 0 ? h("div", { className: "mp-warn" }, t("importSkipDup", { names: duplicates.join(", ") })) : null,
						value.warnings.length > 0 ? h("div", { className: "mp-warn" }, t("partial", { text: value.warnings.join("；") })) : null,
					);
				}
			}

			return h(
				"div",
				{ className: "mp-import" },
				h("div", null, h("strong", null, t("importTitle"))),
				h("div", { className: "mp-note" }, t("importHint")),
				h("textarea", {
					value: text,
					onChange: function (event) { setText(event.target.value); },
					placeholder: t("importPlaceholder"),
					spellCheck: false,
				}),
				summary,
				h(
					"div",
					{ className: "mp-row" },
					h(
						"label",
						{ className: "mp-check", title: t("importReplaceHint") },
						h("input", { type: "checkbox", checked: replace, onChange: function (event) { setReplace(event.target.checked); } }),
						t("importReplace"),
					),
					h("span", { className: "mp-spacer" }),
					h("button", { className: "mp-btn", disabled: pending, onClick: props.onCancel }, t("cancel")),
					h("button", { className: "mp-btn primary", disabled: pending || !ready, onClick: submit }, t("importDo")),
				),
			);
		}

		// ── scope panel ────────────────────────────────────────────────────────
		function ScopePanel(props) {
			var t = props.t;
			var data = props.data;
			var scope = props.scope;
			var [adding, setAdding] = useState(false);
			var [editing, setEditing] = useState(null);
			var [importing, setImporting] = useState(false);
			var [notice, setNotice] = useState("");
			var [overwrite, setOverwrite] = useState(false);
			if (data === undefined || data === null) {
				return h("div", { className: "mp-panel" }, h("div", { className: "mp-empty" }, t("loading")));
			}
			var servers = data.servers || [];
			var status = data.status || "missing";
			var submit = function (originalName) {
				return function (payload, setFields) {
					props.onSave(scope, payload, originalName, setFields, overwrite).then(function (ok) {
						if (ok) {
							setAdding(false);
							setEditing(null);
							setOverwrite(false);
						}
					});
				};
			};
			var runImport = function (text, replace) {
				return props.onImport(scope, text, replace, overwrite).then(function (value) {
					if (!value) return false;
					var names = (value.imported || []).concat(value.replaced || []);
					var line = names.length === 0
						? t("importNothingToDo")
						: t("importDone", { count: names.length, names: names.join(", ") });
					if (value.skipped && value.skipped.length > 0) line += t("importDoneSkip", { count: value.skipped.length });
					setNotice(line);
					setImporting(false);
					setOverwrite(false);
					return true;
				});
			};
			var statusRow = h(
				"div",
				{ className: "mp-file" },
				h("span", { className: "mp-chip " + statusChipClass(status) }, statusText(t, status)),
				h("span", { className: "mp-note" }, t("file") + ":"),
				h("span", { className: "mp-path" }, data.file),
				h("span", { className: "mp-spacer" }),
				data.agents > 0 ? h("span", { className: "mp-note" }, t("agentsHint", { agents: data.agents })) : null,
			);

			var banner = null;
			if (status === "invalid") {
				banner = h(
					"div",
					{ className: "mp-alert" },
					h("div", null, String(data.error || "")),
					h("div", { className: "mp-note" }, t("invalidHint")),
					h(
						"div",
						{ className: "mp-row" },
						h("button", { className: "mp-btn", onClick: function () { props.onReload(scope); } }, t("reload")),
						h("button", { className: "mp-btn danger", onClick: function () { setOverwrite(true); setAdding(true); } }, t("overwrite")),
					),
				);
			} else if (data.mountError) {
				banner = h("div", { className: "mp-alert" }, t("mountError", { error: data.mountError }));
			}

			var warnings = null;
			if (data.warnings && data.warnings.length > 0) {
				warnings = h(
					"div",
					{ className: "mp-warn" },
					h("div", null, t("partial", { text: data.warnings.join("；") })),
				);
			}

			var imported = null;
			if (notice !== "") {
				imported = h("div", { className: "mp-note" }, notice);
			}

			var empty = null;
			if (servers.length === 0 && !adding && !editing && !importing) {
				var hint = status === "empty" ? t("emptyHint") : status === "invalid" ? "" : t("missingHint");
				empty = h("div", { className: "mp-empty" }, hint || t("noServers"));
			}

			var rows = servers.map(function (server) {
				var key = scope + "/" + server.name;
				var probe = props.probes[key];
				var probePill = null;
				if (probe === "pending") probePill = h("span", { className: "mp-pill" }, t("testing"));
				else if (probe && probe.ok) probePill = h("span", { className: "mp-pill ok" }, t("okTools", { count: probe.toolCount, ms: probe.latencyMs }));
				else if (probe && probe.ok === false) probePill = h("span", { className: "mp-pill bad" }, t("probeFailed", { error: probe.error }));
				var editingThis = editing !== null && editing.name === server.name;
				return h(
					"div",
					{ key: key, style: { display: "flex", flexDirection: "column", gap: "8px" } },
					h(
						"div",
						{ className: "mp-server" + (server.enabled === false ? " off" : "") },
						h("span", { className: "mp-sname" }, "mcp__" + server.name + "__*"),
						h("span", { className: "mp-pill" }, server.transport),
						server.enabled === false ? h("span", { className: "mp-pill" }, t("off")) : null,
						h("span", { className: "mp-target" }, targetOf(server)),
						h("span", { className: "mp-spacer" }),
						probePill,
						h(
							"button",
							{
								className: "mp-btn sm",
								disabled: props.busy,
								onClick: function () { props.onProbe(scope, server); },
							},
							t("test"),
						),
						h(
							"button",
							{
								className: "mp-btn sm",
								disabled: props.busy,
								onClick: function () { props.onToggle(scope, server.name, server.enabled === false); },
							},
							server.enabled === false ? t("enable") : t("disable"),
						),
						h(
							"button",
							{
								className: "mp-btn sm",
								disabled: props.busy,
								onClick: function () { setAdding(false); setEditing(editingThis ? null : server); },
							},
							t("edit"),
						),
						h(
							"button",
							{
								className: "mp-btn sm danger",
								disabled: props.busy,
								onClick: function () { props.onRemove(scope, server.name); },
							},
							t("remove"),
						),
					),
					editingThis
						? h(ServerForm, {
							t: t,
							initial: server,
							onCancel: function () { setEditing(null); },
							onSubmit: submit(server.name),
						})
						: null,
				);
			});

			return h(
				"div",
				{ className: "mp-panel" },
				statusRow,
				banner,
				warnings,
				imported,
				h(
					"div",
					{ className: "mp-row" },
					h(
						"button",
						{
							className: "mp-btn primary",
							disabled: props.busy || status === "invalid",
							onClick: function () {
								setNotice("");
								setImporting(false);
								setEditing(null);
								setAdding(adding ? false : true);
							},
						},
						t("add"),
					),
					h(
						"button",
						{
							className: "mp-btn",
							disabled: props.busy || status === "invalid",
							title: t("importHint"),
							onClick: function () {
								setNotice("");
								setAdding(false);
								setEditing(null);
								setImporting(importing ? false : true);
							},
						},
						t("importJson"),
					),
					status === "missing"
						? h("button", { className: "mp-btn", disabled: props.busy, onClick: function () { props.onCreateFile(scope); } }, t("createFile"))
						: null,
					h("span", { className: "mp-spacer" }),
					data.mounted > 0 ? h("span", { className: "mp-note" }, t("connectedAgents", { mounted: data.mounted })) : null,
				),
				empty,
				rows,
				adding
					? h(ServerForm, {
						t: t,
						initial: { transport: "stdio", enabled: true },
						onCancel: function () { setAdding(false); setOverwrite(false); },
						onSubmit: submit(""),
					})
					: null,
				importing
					? h(ImportForm, {
						t: t,
						onPreview: function (text, replace) { return props.onPreviewImport(scope, text, replace); },
						onImport: runImport,
						onDone: function () {},
						onCancel: function () { setImporting(false); setOverwrite(false); },
					})
					: null,
			);
		}

		// ── section ────────────────────────────────────────────────────────────
		function McpSection(props) {
			var ctx = props.ctx;
			var t = function (key, params) {
				var text = ctx.locale.bind(NS)(key);
				return format(text, params);
			};
			var [tab, setTab] = useState("global");
			var [projectDir, setProjectDir] = useState(function () { return readStoredDir(); });
			var [dirDraft, setDirDraft] = useState(function () { return readStoredDir(); });
			var [state, setState] = useState({ loading: true });
			var [error, setError] = useState(null);
			var [busy, setBusy] = useState(false);
			var [probes, setProbes] = useState({});

			var refresh = useCallback(
				async function (dir) {
					setState(function (prev) { return Object.assign({}, prev, { loading: true }); });
					try {
						var value = await callRpc(ctx, "state", { dir: dir === undefined || dir === "" ? null : dir });
						setState(Object.assign({ loading: false }, value));
						if (dir !== undefined && dir !== "" && value.project && value.project.dir && value.project.dir !== dir) {
							// 主机把路径规范化了，跟着它走
							setProjectDir(value.project.dir);
							setDirDraft(value.project.dir);
							storeDir(value.project.dir);
						}
					} catch (err) {
						setState(function (prev) { return Object.assign({}, prev, { loading: false }); });
						setError(errorMessage(err));
					}
				},
				[ctx],
			);

			useEffect(function () {
				void refresh(projectDir);
			}, [refresh]);

			var run = function (action) {
				setBusy(true);
				setError(null);
				return action()
					.then(function () { return true; })
					.catch(function (err) {
						setError(errorMessage(err));
						return false;
					})
					.finally(function () {
						setBusy(false);
					});
			};

			var save = function (scope, server, originalName, setFields, overwrite) {
				return run(function () {
					return callRpc(ctx, "save", {
						scope: scope,
						dir: projectDir || null,
						server: server,
						originalName: originalName,
						overwrite: overwrite === true,
					});
				}).then(function (okFlag) {
					if (!okFlag) return false;
					return refresh(projectDir).then(function () { return true; });
				});
			};

			var remove = function (scope, name) {
				if (!window.confirm(t("removeConfirm", { name: name }))) return Promise.resolve();
				return run(function () {
					return callRpc(ctx, "remove", { scope: scope, dir: projectDir || null, name: name });
				}).then(function () { return refresh(projectDir); });
			};

			var toggle = function (scope, name, enabled) {
				return run(function () {
					return callRpc(ctx, "toggle", { scope: scope, dir: projectDir || null, name: name, enabled: enabled });
				}).then(function () { return refresh(projectDir); });
			};

			var createFile = function (scope) {
				return run(function () {
					return callRpc(ctx, "init", { scope: scope, dir: projectDir || null });
				}).then(function () { return refresh(projectDir); });
			};

			// 预览：宿主只解析、只算同名冲突，不落盘（dryRun）
			var previewImport = function (scope, text, replace) {
				return callRpc(ctx, "import", {
					scope: scope,
					dir: projectDir || null,
					text: text,
					replace: replace === true,
					dryRun: true,
				});
			};

			// 真导入：保留返回值给面板显示「导入了哪几台」
			var importJson = function (scope, text, replace, overwrite) {
				setBusy(true);
				setError(null);
				return callRpc(ctx, "import", {
					scope: scope,
					dir: projectDir || null,
					text: text,
					replace: replace === true,
					overwrite: overwrite === true,
				})
					.then(function (value) {
						return refresh(projectDir).then(function () { return value; });
					})
					.catch(function (err) {
						setError(errorMessage(err));
						return null;
					})
					.finally(function () {
						setBusy(false);
					});
			};

			var reload = function (scope) {
				return run(function () {
					return callRpc(ctx, "reload", { scope: scope, dir: projectDir || null });
				}).then(function () { return refresh(projectDir); });
			};

			var probe = function (scope, server) {
				var key = scope + "/" + server.name;
				setProbes(function (prev) {
					var next = Object.assign({}, prev);
					next[key] = "pending";
					return next;
				});
				callRpc(ctx, "probe", { server: server })
					.then(function (result) {
						setProbes(function (prev) {
							var next = Object.assign({}, prev);
							next[key] = result;
							return next;
						});
					})
					.catch(function (err) {
						setProbes(function (prev) {
							var next = Object.assign({}, prev);
							next[key] = { ok: false, error: errorMessage(err) };
							return next;
						});
					});
			};

			var migrate = function () {
				return run(function () {
					return callRpc(ctx, "migrate", null);
				}).then(function () { return refresh(projectDir); });
			};

			var changeDir = function (value) {
				setDirDraft(value);
				setProjectDir(value);
				storeDir(value);
				void refresh(value);
			};

			var data = state || {};
			var legacy = data.legacy || { count: 0, names: [] };
			var projects = data.projects || [];
			var scoped = tab === "global" ? data.global : data.project;

			return h(
				"div",
				{ className: "mp-root" },
				h(
					"div",
					{ className: "mp-head" },
					h("h2", null, t("title")),
					h("p", null, t("intro")),
				),
				h(
					"div",
					{ className: "mp-bar" },
					h(
						"div",
						{ className: "mp-tabs" },
						h(
							"button",
							{ className: "mp-tab" + (tab === "global" ? " on" : ""), onClick: function () { setTab("global"); } },
							t("tabGlobal"),
						),
						h(
							"button",
							{ className: "mp-tab" + (tab === "project" ? " on" : ""), onClick: function () { setTab("project"); } },
							t("tabProject"),
						),
					),
					h("span", { className: "mp-note" }, tab === "global" ? t("globalHint") : t("projectHint")),
					h("span", { className: "mp-spacer" }),
					h("button", { className: "mp-btn", disabled: busy, onClick: function () { void refresh(projectDir); } }, t("refresh")),
				),
				error !== null ? h("div", { className: "mp-alert" }, t("error") + " · " + error) : null,
				tab === "project"
					? h(
						"div",
						{ className: "mp-panel" },
						h(
							"div",
							{ className: "mp-form", style: { borderTop: 0, paddingTop: 0, marginTop: 0 } },
							h("label", null, t("projectDir")),
							h("input", {
								value: dirDraft || (data.project && data.project.dir) || "",
								onChange: function (event) { setDirDraft(event.target.value); },
								onBlur: function (event) {
									var next = event.target.value.trim();
									if (next !== projectDir) changeDir(next);
								},
								onKeyDown: function (event) {
									if (event.key !== "Enter") return;
									var next = event.target.value.trim();
									if (next !== projectDir) changeDir(next);
								},
								placeholder: t("projectDirPlaceholder"),
								list: "mp-project-dirs",
							}),
							null,
							h("label", null, t("knownProjects")),
							h(
								"div",
								{ className: "mp-row" },
								h(
									"select",
									{
										value: "",
										onChange: function (event) {
											if (event.target.value) changeDir(event.target.value);
										},
										style: { maxWidth: "42ch" },
									},
									h("option", { value: "" }, projects.length === 0 ? t("noProject") : t("pickProject")),
									projects.map(function (item) {
										return h("option", { key: item.dir, value: item.dir }, item.dir);
									}),
								),
								data.project && data.project.dir
									? h("button", { className: "mp-btn sm", onClick: function () { changeDir(data.project.dir); } }, t("useCurrent"))
									: null,
							),
							null,
						),
						h(
							"datalist",
							{ id: "mp-project-dirs" },
							projects.map(function (item) { return h("option", { key: item.dir, value: item.dir }); }),
						),
					)
					: null,
				tab === "global" && legacy.count > 0
					? h(
						"div",
						{ className: "mp-warn" },
						h("div", null, t("legacyTitle", { count: legacy.count })),
						h("div", { className: "mp-note" }, t("legacyBody", { names: legacy.names.join(", ") })),
						h(
							"div",
							{ className: "mp-row" },
							h("button", { className: "mp-btn", disabled: busy, onClick: migrate }, t("legacyAction")),
						),
					)
					: null,
				h(ScopePanel, {
					t: t,
					scope: tab,
					data: scoped,
					busy: busy,
					probes: probes,
					onSave: save,
					onRemove: remove,
					onToggle: toggle,
					onProbe: probe,
					onCreateFile: createFile,
					onReload: reload,
					onPreviewImport: previewImport,
					onImport: importJson,
				}),
			);
		}

		// ── plugin ─────────────────────────────────────────────────────────────
		var inject = ["slots", "connection", "locale"];
		var SECTION_ORDER = 19;

		function apply(ctx) {
			ctx.effect(function () {
				injectStyles();
				return function () {};
			}, "mcp-management: styles");
			ctx.effect(function () { return ctx.locale.register(NS, { zh: zh, en: en }); }, "mcp-management: locale");
			var t = ctx.locale.bind(NS);
			ctx.effect(function () { return watchNav(t); }, "mcp-management: nav mark");
			ctx.slots.inject("settings.section", function () {
				return ctx.slots.register({
					name: "settings.section",
					id: "mcp-management",
					order: SECTION_ORDER,
					label: function () { return t("nav"); },
					inject: function () { return { ctx: ctx }; },
				}, McpSection);
			});
		}

		module.exports = { apply: apply, inject: inject };
		return module.exports;
	},
});
