/**
 * 显示优化 — Client 半(手写 ModuleLoader bundle,格式与官方 dsh-client-ui-* 包一致)
 *
 * 1) shell.overlay 右侧悬浮窗:上方上下文占用圆环,下方提供商余额/用量与会话消耗
 *    · deepseek-official:账户余额(CNY)+ 会话累计消耗
 *    · opencode-go:订阅制说明(无余额接口)+ 会话累计消耗(USD)
 * 2) conversation.chat.assistant-actions 每消息注入:统计行追加"· 本条 $/¥ x.xxxx"
 * 3) conversation.input.right 提供商图标:模型选择器左侧的自绘 SVG 图标
 *    (DeepSeek 小鲸鱼 / OpenCode Go 大写 G),订阅共享模型目录 store,切换即时更新
 * 数据来自同源路由 /api/dsh-balance(宿主代理,浏览器不接触 API Key);
 * 每消息消耗按客户端快照 node.usage 纯计算,定价表与宿主一致。
 */
window.__ModuleLoader__.load({
	id: "uiopt",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		let react = require("react");

		const NS = "显示优化";
		const num = (v) => (typeof v === "number" && Number.isFinite(v) && v > 0 ? v : 0);

		const symbolOf = (c) => c === "CNY" ? "¥" : c === "USD" ? "$" : (c ? c + " " : "");
		const providerLabel = (p) => (p === "opencode-go" ? "OpenCode Go" : p === "deepseek-official" ? "DeepSeek" : p || "DeepSeek");
		const fmt = (n) => { const t = String(n); return t.length ? t : "0.00"; };
		const money = (v) => { const x = Number(v); if (!isFinite(x)) return "?"; return x >= 0.01 ? x.toFixed(2) : x.toFixed(4); };

		const dockStyle = { display: "flex", alignItems: "center", flexWrap: "wrap", gap: "2px 12px", fontSize: "12px", lineHeight: "1.5", color: "var(--dsw-alias-label-secondary)", padding: "2px 0" };
		const amountStyle = { color: "var(--dsw-alias-label-primary)", fontWeight: 600, fontVariantNumeric: "tabular-nums" };
		const detailStyle = { opacity: 0.85 };
		const okStyle = { color: "var(--dsw-alias-state-success-primary)" };
		const badStyle = { color: "var(--dsw-alias-state-error-primary)" };
		const errStyle = { color: "var(--dsw-alias-state-warn-primary)" };
		const missingKeyStyle = { color: "var(--dsw-alias-state-warn-primary)", fontWeight: 600 };
		const dotStyle = { display: "inline-block", width: 8, height: 8, borderRadius: "50%", marginRight: 5, verticalAlign: 1, background: "currentColor" };
		const btnStyle = { background: "transparent", border: "1px solid var(--dsw-alias-border-l1)", color: "var(--dsw-alias-label-secondary)", borderRadius: 4, fontSize: 11, padding: "0 8px", lineHeight: "18px", cursor: "pointer" };
		const costStyle = { fontSize: "11px", lineHeight: "20px", color: "var(--dsw-alias-label-secondary)", opacity: 0.85, whiteSpace: "nowrap", margin: "0 2px" };
		const iconWrapStyle = { display: "inline-flex", alignItems: "center", justifyContent: "center", width: 20, height: 20, marginRight: -10, flex: "none", cursor: "default" };

		// ---- 右侧悬浮窗:上方上下文圆环,下方提供商余额(可拖拽) ----
		const RING_SIZE = 84;
		const floatWrap = { position: "fixed", right: 16, top: "50%", transform: "translateY(-50%)", width: 150, background: "var(--dsw-alias-bg-overlay)", border: "1px solid var(--dsw-alias-border-l1)", borderRadius: 14, padding: "10px 8px 8px", display: "flex", flexDirection: "column", alignItems: "center", gap: 6, boxShadow: "0 10px 32px rgba(0,0,0,0.22)", pointerEvents: "auto", zIndex: 60, userSelect: "none", cursor: "grab", touchAction: "none" };
		const floatTitle = { fontSize: 11, color: "var(--dsw-alias-label-secondary)", fontWeight: 600, letterSpacing: "0.04em" };
		const floatRow = { fontSize: 12, lineHeight: "18px", color: "var(--dsw-alias-label-secondary)", textAlign: "center" };
		const floatAmount = { fontSize: 14, fontWeight: 700, color: "var(--dsw-alias-label-primary)", fontVariantNumeric: "tabular-nums" };

		// ---- 模型分布数据(来自 /api/dsh-balance 的 perMessage 明细,按模型聚合) ----
		const DONUT_COLORS = ["#4c9aff", "#37d2a8", "#f2b53d", "#e07b9a", "#9b7bff", "#58c7e8", "#e8a04c", "#7fd08a", "#d97f5a", "#6fb1e0"];
		function modelDistFromPerMessage(perMessage) {
			if (!perMessage || typeof perMessage !== "object") return [];
			const agg = {};
			for (const k of Object.keys(perMessage)) {
				const e = perMessage[k];
				if (!e || typeof e.a !== "number" || !Number.isFinite(e.a) || e.a <= 0) continue;
				const m = typeof e.m === "string" && e.m.length > 0 ? e.m : "未知";
				if (!agg[m]) agg[m] = { amount: 0, count: 0, currency: typeof e.c === "string" ? e.c : "CNY" };
				agg[m].amount += e.a;
				agg[m].count += 1;
			}
			return Object.keys(agg).map((m) => ({ model: m, amount: Math.round(agg[m].amount * 10000) / 10000, count: agg[m].count, currency: agg[m].currency }))
				.sort((x, y) => y.amount - x.amount);
		}

		// ---- 悬浮窗圆环(一圈):总弧长 = 上下文占用,环上按模型消耗占比分色段;下方图例 ----
		const ContextRing = react.memo(function ContextRing({ percent, perMessage }) {
			const cx = RING_SIZE / 2;
			const r = 30;
			const circ = 2 * Math.PI * r;
			const p = typeof percent === "number" ? Math.max(0, Math.min(100, percent)) : 0;
			const baseColor = p >= 90 ? "var(--dsw-alias-state-error-primary)" : p >= 70 ? "var(--dsw-alias-state-warn-primary)" : "var(--dsw-alias-state-success-primary)";
			// 占用弧长按模型消耗占比分段(无模型数据时退化为单色整段)
			const items = modelDistFromPerMessage(perMessage);
			const total = items.reduce((s, it) => s + it.amount, 0);
			const usedLen = (circ * p) / 100;
			const segs = [];
			if (items.length > 0 && total > 0 && usedLen > 0) {
				let offset = 0;
				items.forEach((it, i) => {
					const len = usedLen * (it.amount / total);
					segs.push(react.createElement("circle", {
						key: "seg" + i,
						cx: cx, cy: cx, r: r,
						fill: "none",
						stroke: DONUT_COLORS[i % DONUT_COLORS.length],
						strokeWidth: 7,
						strokeDasharray: String(len) + " " + String(circ),
						strokeDashoffset: String(-offset),
						transform: "rotate(-90 " + cx + " " + cx + ")"
					}));
					offset += len;
				});
			} else if (usedLen > 0) {
				segs.push(react.createElement("circle", { key: "seg0", cx: cx, cy: cx, r: r, fill: "none", stroke: baseColor, strokeWidth: 7, strokeLinecap: "round", strokeDasharray: String(usedLen) + " " + String(circ), transform: "rotate(-90 " + cx + " " + cx + ")" }));
			}
			// 图例:前 4 个模型 + "其他"(有分布数据才显示)
			const legend = [];
			if (items.length > 0 && total > 0) {
				const shown = items.slice(0, 4);
				shown.forEach((it, i) => {
					const pct = Math.round((it.amount / total) * 1000) / 10;
					legend.push(react.createElement("div", { key: "lg" + i, style: { display: "flex", alignItems: "center", gap: 4, width: "100%", fontSize: 10, lineHeight: "16px", color: "var(--dsw-alias-label-secondary)" } },
						react.createElement("span", { style: { width: 8, height: 8, borderRadius: "50%", background: DONUT_COLORS[i % DONUT_COLORS.length], flex: "none" } }),
						react.createElement("span", { style: { flex: 1, minWidth: 0, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", textAlign: "left" } }, it.model),
						react.createElement("span", { style: { color: "var(--dsw-alias-label-primary)", fontWeight: 600, fontVariantNumeric: "tabular-nums", flex: "none" } }, symbolOf(it.currency) + money(it.amount) + " " + pct + "%")
					));
				});
				if (items.length > shown.length) {
					const rest = items.slice(shown.length);
					const restAmount = rest.reduce((s, it) => s + it.amount, 0);
					const restPct = Math.round((restAmount / total) * 1000) / 10;
					legend.push(react.createElement("div", { key: "lg-rest", style: { display: "flex", alignItems: "center", gap: 4, width: "100%", fontSize: 10, lineHeight: "16px", color: "var(--dsw-alias-label-secondary)" } },
						react.createElement("span", { style: { width: 8, height: 8, borderRadius: "50%", background: "var(--dsw-alias-border-l2)", flex: "none" } }),
						react.createElement("span", { style: { flex: 1, minWidth: 0, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", textAlign: "left" } }, "其他 " + rest.length + " 个模型"),
						react.createElement("span", { style: { color: "var(--dsw-alias-label-primary)", fontWeight: 600, fontVariantNumeric: "tabular-nums", flex: "none" } }, symbolOf(rest[0].currency) + money(restAmount) + " " + restPct + "%")
					));
				}
			}
			return react.createElement("div", { style: { width: "100%", display: "flex", flexDirection: "column", alignItems: "center", gap: 3 } },
				react.createElement("div", { style: { position: "relative", width: RING_SIZE, height: RING_SIZE, display: "flex", alignItems: "center", justifyContent: "center" } },
					react.createElement("svg", { width: RING_SIZE, height: RING_SIZE, viewBox: "0 0 " + RING_SIZE + " " + RING_SIZE },
						react.createElement("circle", { cx: cx, cy: cx, r: r, fill: "none", stroke: "var(--dsw-alias-border-l1)", strokeWidth: 7 }),
						segs
					),
					react.createElement("div", { style: { position: "absolute", textAlign: "center" } },
						react.createElement("div", { style: { fontSize: 16, fontWeight: 700, color: "var(--dsw-alias-label-primary)" } }, typeof percent === "number" ? String(p) + "%" : "--"),
						react.createElement("div", { style: { fontSize: 9, color: "var(--dsw-alias-label-secondary)" } }, "上下文")
					)
				),
				legend
			);
		});

		function FloatingWidget(props) {
			const current = props.useSessions ? props.useSessions((s) => (s ? s.current : undefined)) : undefined;
			const summary = props.useSessions ? props.useSessions((s) => (s && s.byId && current ? s.byId[current] : undefined)) : undefined;
			const running = summary ? !!summary.running : false;
			const [ctxData, setCtxData] = react.useState(null);
			const [bal, setBal] = react.useState(null);
			const [liveSel, setLiveSel] = react.useState(null);
			const [pos, setPos] = react.useState(null);
			const dragRef = react.useRef(null);
			const prevRunningRef = react.useRef(null);
			// 订阅会话共享模型目录 store(provider|model);目录未就绪时主动 load 保证上报值准确
			react.useEffect(() => {
				const dirs = props.modelDirectories;
				if (!dirs || !current) {
					setLiveSel(null);
					return undefined;
				}
				let dir = null;
				let store = null;
				try {
					dir = dirs.directoryFor(current);
					store = dir.store;
				} catch (e) {
					setLiveSel(null);
					return undefined;
				}
				const update = () => {
					let s = null;
					try {
						const st = store.getSnapshot();
						if (st && st.current && typeof st.current.provider === "string" && st.current.provider.length > 0) {
							s = st.current.provider + "|" + (typeof st.current.model === "string" ? st.current.model : "");
						}
					} catch (e2) {
						s = null;
					}
					setLiveSel(s);
				};
				update();
				// 目录从未加载(切换会话后新目录常为空):主动拉取该会话的模型选择
				try {
					const st0 = store.getSnapshot();
					if (!st0 || !st0.current) {
						if (typeof dir.load === "function") dir.load().catch(() => {});
					}
				} catch (e3) {
					/* ignore */
				}
				return store.subscribe(update);
			}, [current, props.modelDirectories]);
			const liveProvider = liveSel ? liveSel.split("|")[0] : null;
			const liveModel = liveSel && liveSel.indexOf("|") >= 0 ? liveSel.split("|")[1] : null;
			const ctxSeqRef = react.useRef(0);
			const balSeqRef = react.useRef(0);
			// 会话级数据缓存:切换会话时立即显示上次数据(瞬间切换),后台静默刷新
			const cacheRef = react.useRef({});
			const refreshCtx = react.useCallback(() => {
				if (!current) return;
				const mySeq = ++ctxSeqRef.current;
				const pr = liveProvider ? "&provider=" + encodeURIComponent(liveProvider) : "";
				const md = liveModel ? "&model=" + encodeURIComponent(liveModel) : "";
				fetch("/api/dsh-context?sessionId=" + encodeURIComponent(current) + pr + md).then((r) => r.json()).then((res) => {
					const ok = res && res.ok ? res : null;
					const c = cacheRef.current[current] || (cacheRef.current[current] = {});
					c.ctx = ok;
					if (mySeq === ctxSeqRef.current) setCtxData(ok);
				}, () => {
					if (mySeq === ctxSeqRef.current) setCtxData(null);
				});
			}, [current, liveProvider, liveModel]);
			const refreshBal = react.useCallback(() => {
				if (!current) return;
				const mySeq = ++balSeqRef.current;
				const pr = liveProvider ? "&provider=" + encodeURIComponent(liveProvider) : "";
				fetch("/api/dsh-balance?sessionId=" + encodeURIComponent(current) + pr).then((r) => r.json()).then((res) => {
					const c = cacheRef.current[current] || (cacheRef.current[current] = {});
					c.bal = res;
					if (mySeq === balSeqRef.current) setBal(res);
				}, () => { if (mySeq === balSeqRef.current) setBal(null); });
			}, [current, liveProvider]);
			const refreshRef = react.useRef({ refreshCtx, refreshBal });
			react.useEffect(() => {
				refreshRef.current = { refreshCtx, refreshBal };
			});
			const pendingRef = react.useRef(null);
			const scheduleRefresh = react.useCallback(() => {
				if (pendingRef.current !== null) return;
				pendingRef.current = setTimeout(() => {
					pendingRef.current = null;
					const r = refreshRef.current;
					r.refreshCtx();
					r.refreshBal();
				}, 60);
			}, []);
			// 切换会话:先用缓存立即显示(瞬间切换),再后台刷新;不主动清 liveSel——
			// 目录订阅 effect 会同步为新会话的 provider,清空反而引起多轮无效刷新
			react.useEffect(() => {
				const cached = cacheRef.current[current];
				if (cached) {
					if (Object.prototype.hasOwnProperty.call(cached, "ctx")) setCtxData(cached.ctx);
					if (Object.prototype.hasOwnProperty.call(cached, "bal")) setBal(cached.bal);
				} else {
					setCtxData(null);
					setBal(null);
				}
				scheduleRefresh();
			}, [current]);
			// 切换模型/供应商:重新拉取余额与上下文
			react.useEffect(() => {
				if (liveSel) scheduleRefresh();
			}, [liveSel]);
			// 回合结束(running 下降沿):刷新全部状态(余额差逐条明细随之更新)
			react.useEffect(() => {
				if (prevRunningRef.current === true && running === false) {
					scheduleRefresh();
					// 宿主在消息完成后 5~20s 才完成余额差绑定:补一次延迟刷新,让明细落地后 UI 自动切换为真实值
					setTimeout(() => { scheduleRefresh(); }, 6000);
				}
				prevRunningRef.current = running;
			}, [running]);
			// 拖拽
			const onPointerDown = (e) => {
				const rect = e.currentTarget.getBoundingClientRect();
				dragRef.current = { dx: e.clientX - rect.left, dy: e.clientY - rect.top, moved: false };
			};
			const dragRafRef = react.useRef(null);
			const dragPendingRef = react.useRef(null);
			react.useEffect(() => {
				const move = (e) => {
					if (!dragRef.current) return;
					dragRef.current.moved = true;
					// rAF 节流:pointermove 高频事件合并为每帧一次 setState,避免拖拽卡顿
					dragPendingRef.current = { x: e.clientX - dragRef.current.dx, y: e.clientY - dragRef.current.dy };
					if (dragRafRef.current === null) {
						dragRafRef.current = requestAnimationFrame(() => {
							dragRafRef.current = null;
							if (dragPendingRef.current) setPos(dragPendingRef.current);
						});
					}
				};
				const up = () => {
					dragRef.current = null;
					dragPendingRef.current = null;
					if (dragRafRef.current !== null) {
						cancelAnimationFrame(dragRafRef.current);
						dragRafRef.current = null;
					}
				};
				window.addEventListener("pointermove", move);
				window.addEventListener("pointerup", up);
				return () => {
					window.removeEventListener("pointermove", move);
					window.removeEventListener("pointerup", up);
					if (dragRafRef.current !== null) {
						cancelAnimationFrame(dragRafRef.current);
						dragRafRef.current = null;
					}
				};
			}, []);
			if (!current) return null;
			const wrapStyle = pos ? { ...floatWrap, left: pos.x, top: pos.y, right: "auto", transform: "none" } : floatWrap;
			const cells = [];
			cells.push(react.createElement("div", { key: "title", style: floatTitle }, "显示优化"));
			cells.push(react.createElement(ContextRing, { key: "ring", percent: ctxData ? ctxData.percent : null, perMessage: bal && bal.ok ? bal.perMessage : null }));
			const res = bal;
			if (res && res.ok) {
				cells.push(react.createElement("div", { key: "prov", style: floatRow }, providerLabel(res.provider)));
				if (res.balanceType === "unsupported") {
					cells.push(react.createElement("div", { key: "sub", style: floatRow }, res.note || "该供应商暂不支持余额查询"));
				} else if (res.balanceType === "subscription") {
					if (res.errorCode === "MISSING_API_KEY") {
						cells.push(react.createElement("div", { key: "sub", style: { ...floatRow, color: "var(--dsw-alias-state-warn-primary)", fontWeight: 600 } }, "请先输入 OpenCode API Key"));
					} else if (res.usage && (res.usage.rolling || res.usage.weekly || res.usage.monthly)) {
						const windows = [["5h", res.usage.rolling], ["周", res.usage.weekly], ["月", res.usage.monthly]];
						const parts = [];
						for (const [lb, w] of windows) {
							if (w && typeof w.percent === "number") parts.push(lb + " " + w.percent + "%");
						}
						cells.push(react.createElement("div", { key: "sub", style: floatRow }, parts.join(" · ")));
					} else if (res.error) {
						cells.push(react.createElement("div", { key: "sub", style: floatRow }, "OpenCode " + res.error));
					} else {
						cells.push(react.createElement("div", { key: "sub", style: floatRow }, "OpenCode Go · 订阅制"));
					}
				} else if (res.infos && res.infos.length > 0) {
					res.infos.forEach((b, i) => {
						cells.push(react.createElement("div", { key: "cur" + i, style: floatAmount }, "余额: " + symbolOf(b.currency) + fmt(b.total)));
					});
					cells.push(react.createElement("div", { key: "avail", style: { ...floatRow, color: res.isAvailable ? "var(--dsw-alias-state-success-primary)" : "var(--dsw-alias-state-error-primary)" } },
						res.isAvailable ? "可用" : "余额不足"
					));
				}
				if (res.sessionCost !== null && res.sessionCost !== undefined) {
					cells.push(react.createElement("div", { key: "cost", style: { ...floatRow, fontWeight: 600, color: "var(--dsw-alias-label-primary)" } },
						"本会话已用 " + symbolOf(res.sessionCurrency || "CNY") + money(res.sessionCost)
					));
				}
			} else if (res && res.error) {
				cells.push(react.createElement("div", { key: "err", style: floatRow }, res.error));
			} else {
				cells.push(react.createElement("div", { key: "load", style: floatRow }, "加载中…"));
			}
			return react.createElement("div", { style: wrapStyle, onPointerDown: onPointerDown }, cells);
		}

		/** 每条 assistant 消息:仅显示本条缓存命中率(价格逻辑已移除)。 */
		function MessageCostAction(props) {
			const messageId = props.messageId;
			const node = props.useSession((s) => {
				if (!s) return null;
				const nodes = s.chat && s.chat.legacy && s.chat.legacy.nodes ? s.chat.legacy.nodes : (Array.isArray(s.nodes) ? s.nodes : null);
				if (!nodes) return null;
				for (let i = 0; i < nodes.length; i++) {
					const n = nodes[i];
					if (n && n.kind === "assistant" && n.messageId === messageId) return n;
				}
				return null;
			});
			if (!node || !node.usage) return null;
			const u = node.usage;
			const inT = num(u.inputTokens);
			const cacheT = num(u.cacheReadTokens);
			const writeT = num(u.cacheWriteTokens);
			const d = inT + cacheT + writeT;
			if (d <= 0) return null;
			const hit = Math.round((cacheT / d) * 1000) / 10;
			return react.createElement("span", { style: costStyle }, "· 缓存 " + hit + "%");
		}

		/** DeepSeek 小鲸鱼(自绘 SVG:圆润鲸鱼轮廓 + 白色镂空 "Ai",明亮蓝渐变,贴合官方 logo 意象)。 */
		function WhaleIcon() {
			return react.createElement("svg", { viewBox: "0 0 50 50", width: 16, height: 16, "aria-hidden": true, focusable: "false" },
				react.createElement("path", {
					fill: "#4D6BFE",
					fillRule: "nonzero",
					d: "M48.8354 10.0479C48.3232 9.79199 48.1025 10.2798 47.8032 10.5278C47.7007 10.6079 47.6143 10.7119 47.5273 10.8076C46.7793 11.624 45.9048 12.1597 44.7622 12.0957C43.0923 12 41.666 12.5356 40.4058 13.8398C40.1377 12.2319 39.2476 11.272 37.8926 10.6558C37.1836 10.3359 36.4668 10.0156 35.9702 9.31982C35.6235 8.82373 35.5293 8.27197 35.356 7.72754C35.2456 7.3999 35.1353 7.06396 34.7651 7.00781C34.3633 6.94385 34.2056 7.2876 34.0479 7.57568C33.418 8.75195 33.1733 10.0479 33.1973 11.3599C33.2524 14.312 34.4736 16.6641 36.8999 18.3359C37.1758 18.5278 37.2466 18.7197 37.1597 19C36.9946 19.5757 36.7974 20.1357 36.624 20.7119C36.5137 21.0801 36.3486 21.1597 35.9624 21C34.6309 20.4321 33.481 19.5918 32.4644 18.5757C30.7393 16.8721 29.1792 14.9917 27.2334 13.52C26.7764 13.1758 26.3193 12.856 25.8467 12.5518C23.8618 10.584 26.1069 8.96777 26.627 8.77588C27.1704 8.57568 26.8159 7.8877 25.0591 7.896C23.3022 7.90381 21.6953 8.50391 19.647 9.30371C19.3477 9.42383 19.0322 9.51172 18.7095 9.58398C16.8501 9.22363 14.9199 9.14355 12.9033 9.37598C9.10596 9.80762 6.07275 11.6396 3.84326 14.7681C1.16455 18.5278 0.53418 22.7998 1.30664 27.2559C2.11768 31.9521 4.46582 35.8398 8.07373 38.8799C11.8159 42.0322 16.1255 43.5762 21.041 43.2803C24.0269 43.104 27.3516 42.6963 31.1016 39.4561C32.0469 39.936 33.0396 40.1279 34.686 40.272C35.9546 40.3921 37.1758 40.208 38.1211 40.0078C39.6021 39.688 39.4995 38.2881 38.9639 38.0322C34.623 35.9678 35.5762 36.8081 34.71 36.1279C36.9155 33.4639 40.2402 30.6958 41.54 21.728C41.6426 21.0161 41.5557 20.5679 41.54 19.9917C41.5322 19.6396 41.6108 19.5039 42.0049 19.4639C43.0923 19.3359 44.1479 19.0317 45.1167 18.4878C47.9292 16.9199 49.064 14.3438 49.3315 11.2559C49.3711 10.7837 49.3237 10.2959 48.8354 10.0479ZM24.3262 37.8398C20.1196 34.4639 18.0791 33.3521 17.2358 33.3999C16.4482 33.4482 16.5898 34.3682 16.7632 34.9678C16.9443 35.5601 17.1812 35.9683 17.5117 36.4878C17.7402 36.832 17.8979 37.3442 17.2832 37.728C15.9282 38.584 13.5728 37.4399 13.4624 37.3838C10.7207 35.7358 8.42822 33.5601 6.81348 30.584C5.25342 27.7197 4.34766 24.6479 4.19775 21.3677C4.1582 20.5757 4.38672 20.2959 5.15869 20.1519C6.17529 19.96 7.22314 19.9199 8.23926 20.0718C12.5327 20.7119 16.1885 22.6719 19.2529 25.7759C21.002 27.5439 22.3252 29.6558 23.6885 31.7202C25.1377 33.9121 26.6978 36 28.6831 37.7119C29.3843 38.312 29.9434 38.7681 30.479 39.104C28.8643 39.2881 26.1699 39.3281 24.3262 37.8398ZM26.3433 24.6001C26.3433 24.248 26.6191 23.9678 26.9658 23.9678C27.0444 23.9678 27.1152 23.9839 27.1782 24.0078C27.2651 24.04 27.3438 24.0879 27.4067 24.1602C27.5171 24.272 27.5801 24.4321 27.5801 24.6001C27.5801 24.9521 27.3042 25.2319 26.9575 25.2319C26.6108 25.2319 26.3433 24.9521 26.3433 24.6001ZM32.6064 27.8799C32.2046 28.0479 31.8027 28.1919 31.4165 28.208C30.8179 28.2397 30.1641 27.9922 29.8096 27.688C29.2583 27.2158 28.8643 26.9521 28.6987 26.1279C28.6279 25.7759 28.6675 25.2319 28.7305 24.9199C28.8721 24.248 28.7144 23.8159 28.2495 23.4238C27.8716 23.104 27.3911 23.0161 26.8633 23.0161C26.666 23.0161 26.4849 22.9277 26.3511 22.856C26.1304 22.7441 25.9492 22.4639 26.1226 22.1201C26.1777 22.0078 26.4458 21.7358 26.5088 21.688C27.2256 21.272 28.0527 21.4077 28.8169 21.7197C29.5259 22.0161 30.0615 22.5601 30.834 23.3281C31.6216 24.2559 31.7632 24.5117 32.2124 25.208C32.5669 25.752 32.8901 26.312 33.1104 26.9521C33.2446 27.3521 33.0713 27.6802 32.6064 27.8799Z"
				})
			);
		}

		function OpenCodeGIcon() {
			return react.createElement("svg", { viewBox: "0 0 24 24", width: 16, height: 16, "aria-hidden": true, focusable: "false" },
				react.createElement("circle", { cx: 12, cy: 12, r: 10.5, fill: "#7C3AED" }),
				react.createElement("text", { x: 12, y: 16.7, textAnchor: "middle", fontSize: 14, fontWeight: 800, fill: "#ffffff", fontFamily: "Inter, system-ui, -apple-system, sans-serif" }, "G")
			);
		}

		/**
		 * 模型选择器左侧的提供商图标:订阅共享模型目录 store,
		 * 模型/提供商切换即时更新;目录不可用时静默隐藏。
		 */
		function ProviderIcon(props) {
			const [provider, setProvider] = react.useState(null);
			react.useEffect(() => {
				const dirs = props.modelDirectories;
				if (!dirs || !props.sessionId) return undefined;
				let store = null;
				try {
					store = dirs.directoryFor(props.sessionId).store;
				} catch (e) {
					return undefined;
				}
				const update = () => {
					let p = null;
					try {
						const s = store.getSnapshot();
						if (s && s.current && typeof s.current.provider === "string" && s.current.provider.length > 0) p = s.current.provider;
					} catch (e2) {
						p = null;
					}
					setProvider(p);
				};
				update();
				return store.subscribe(update);
			}, [props.sessionId, props.modelDirectories]);
			if (provider === "deepseek-official") {
				return react.createElement("span", { style: iconWrapStyle, title: "DeepSeek" }, react.createElement(WhaleIcon, null));
			}
			if (provider === "opencode-go") {
				return react.createElement("span", { style: iconWrapStyle, title: "OpenCode Go" }, react.createElement(OpenCodeGIcon, null));
			}
			return null;
		}

		// ---- 设置 → 插件 → 自主添加插件 标签页(格式与"插件配置/插件清单"一致) ----
		const selfTabSection = { display: "flex", flexDirection: "column", gap: 10 };
		const selfTabStatus = { color: "var(--dsw-alias-label-secondary)", fontSize: 13, lineHeight: "20px", margin: 0 };
		const selfTabHeading = { display: "flex", alignItems: "center", gap: 8, margin: 0, fontSize: 14, fontWeight: 600, color: "var(--dsw-alias-label-primary)" };
		const selfTabCount = { fontSize: 12, color: "var(--dsw-alias-label-secondary)", border: "1px solid var(--dsw-alias-border-l1)", borderRadius: 999, padding: "0 8px", lineHeight: "18px" };
		const selfTabCards = { display: "flex", flexDirection: "column", gap: 8, margin: 0, padding: 0, listStyle: "none" };
		const selfTabCard = { border: "1px solid var(--dsw-alias-border-l1)", borderRadius: 10, background: "var(--dsw-alias-bg-layer-1)", overflow: "hidden" };
		const selfTabCardBtn = { display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10, width: "100%", padding: "10px 12px", background: "none", border: "none", cursor: "pointer", textAlign: "left", color: "inherit", font: "inherit" };
		const selfTabTitle = { fontSize: 14, fontWeight: 600, color: "var(--dsw-alias-label-primary)" };
		const selfTabTrail = { display: "flex", alignItems: "center", gap: 8, flex: "none" };
		const selfTabDot = { width: 8, height: 8, borderRadius: "50%", background: "var(--dsw-alias-state-success-primary)", flex: "none" };
		const selfTabTag = { fontSize: 11, lineHeight: "18px", padding: "0 8px", borderRadius: 999, border: "1px solid var(--dsw-alias-border-l1)", color: "var(--dsw-alias-label-secondary)" };
		const selfTabDetails = { display: "flex", flexDirection: "column", gap: 4, padding: "0 12px 10px", fontSize: 12, lineHeight: "18px", color: "var(--dsw-alias-label-secondary)" };
		const selfTabCode = { fontFamily: "ui-monospace, monospace", background: "var(--dsw-alias-bg-layer-2)", borderRadius: 4, padding: "1px 6px", wordBreak: "break-all" };

		const selfTabGroupTitle = { display: "flex", alignItems: "center", gap: 8, margin: "14px 0 0", fontSize: 13, fontWeight: 600, color: "var(--dsw-alias-label-primary)" };
		// ---- 导入插件 相关样式(风格与现有按钮一致,略加大带边框) ----
		const importBtnStyle = { ...btnStyle, fontSize: 13, padding: "7px 16px", lineHeight: "20px", borderRadius: 8, border: "1.5px solid var(--dsw-alias-border-l2)", color: "var(--dsw-alias-label-primary)", background: "var(--dsw-alias-bg-layer-1)", fontWeight: 500 };
		const importRowStyle = { display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" };
		const importStatusStyle = { fontSize: 12, lineHeight: "18px", margin: 0, color: "var(--dsw-alias-label-secondary)" };
		const importOkStyle = { fontSize: 12, lineHeight: "18px", margin: 0, color: "var(--dsw-alias-state-success-primary)", fontWeight: 600 };
		const importErrStyle = { fontSize: 12, lineHeight: "18px", margin: 0, color: "var(--dsw-alias-state-error-primary)" };
		const importHintStyle = { fontSize: 11, lineHeight: "18px", margin: 0, color: "var(--dsw-alias-label-secondary)", opacity: 0.85 };

		// ---- dsh-vision 视觉模型配置面板(数据/写入走官方 settings 通道,宿主 API 转发) ----
		function VisionConfigPanel() {
			const [state, setState] = react.useState({ status: "loading" });
			const [draft, setDraft] = react.useState(null);
			const [saving, setSaving] = react.useState(false);
			const [message, setMessage] = react.useState(null);
			react.useEffect(() => {
				let current = true;
				fetch("/api/dsh-vision/ui").then((r) => r.json()).then((res) => {
					if (!current) return;
					if (res && res.ok) {
						setState({ status: "ready", config: res.config, models: res.models || [] });
						setDraft({
							provider: res.config.provider,
							model: res.config.model,
							maxTokens: res.config.maxTokens,
							mode: res.config.mode,
							timeoutMs: res.config.timeoutMs
						});
					} else setState({ status: "error" });
				}, () => { if (current) setState({ status: "error" }); });
				return () => { current = false; };
			}, []);
			if (state.status === "loading") return react.createElement("p", { style: selfTabStatus }, "加载配置…");
			if (state.status === "error") return react.createElement("p", { style: selfTabStatus, role: "alert" }, "无法读取 dsh-vision 配置(插件未挂载或宿主 API 不可用)");
			const groups = state.models;
			const onSelect = (e) => {
				const v = String(e.target.value || "");
				const idx = v.indexOf("\u0000");
				if (idx < 0) return;
				setDraft({ ...draft, provider: v.slice(0, idx), model: v.slice(idx + 1) });
				setMessage(null);
			};
			const onNumber = (key) => (e) => {
				const n = Number(e.target.value);
				if (Number.isFinite(n) && n > 0) { setDraft({ ...draft, [key]: n }); setMessage(null); }
			};
			const onSave = () => {
				setSaving(true);
				setMessage(null);
				fetch("/api/dsh-vision/ui", {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify(draft)
				}).then((r) => r.json()).then((res) => {
					setSaving(false);
					if (res && res.ok) {
						setState({ status: "ready", config: res.config, models: groups });
						setMessage({ ok: true, text: "已保存,下一次识图立即生效" });
					} else setMessage({ ok: false, text: (res && res.error) || "保存失败" });
				}, () => { setSaving(false); setMessage({ ok: false, text: "请求失败" }); });
			};
			const rowStyle = { display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" };
			const labelStyle = { ...selfTabStatus, minWidth: 56, flex: "none" };
			const fieldStyle = { background: "var(--dsw-alias-bg-layer-2)", color: "var(--dsw-alias-label-primary)", border: "1px solid var(--dsw-alias-border-l1)", borderRadius: 6, padding: "3px 8px", fontSize: 12, lineHeight: "18px" };
			const cells = [];
			cells.push(react.createElement("div", { key: "model-row", style: rowStyle },
				react.createElement("span", { style: labelStyle }, "视觉模型"),
				react.createElement("select", { value: draft ? draft.provider + "\u0000" + draft.model : "", onChange: onSelect, style: fieldStyle },
					groups.map((g) => react.createElement("optgroup", { key: g.provider, label: g.providerName + " (" + g.provider + ")" },
						g.models.map((m) => react.createElement("option", { key: g.provider + "\u0000" + m.id, value: g.provider + "\u0000" + m.id }, m.id + (m.name && m.name !== m.id ? " · " + m.name : "")))
					))
				)
			));
			cells.push(react.createElement("div", { key: "adv-row", style: rowStyle },
				react.createElement("span", { style: labelStyle }, "输出上限"),
				react.createElement("input", { type: "number", min: 1, value: draft ? draft.maxTokens : "", onChange: onNumber("maxTokens"), style: { ...fieldStyle, width: 88 } }),
				react.createElement("span", { style: labelStyle }, "模式"),
				react.createElement("select", { value: draft ? draft.mode : "both", onChange: (e) => { setDraft({ ...draft, mode: e.target.value }); setMessage(null); }, style: fieldStyle },
					react.createElement("option", { value: "both" }, "自动桥 + see_image"),
					react.createElement("option", { value: "auto" }, "仅自动桥"),
					react.createElement("option", { value: "manual" }, "仅 see_image 工具")
				),
				react.createElement("span", { style: labelStyle }, "超时ms"),
				react.createElement("input", { type: "number", min: 1000, value: draft ? draft.timeoutMs : "", onChange: onNumber("timeoutMs"), style: { ...fieldStyle, width: 88 } })
			));
			cells.push(react.createElement("div", { key: "save-row", style: { display: "flex", alignItems: "center", gap: 8, marginTop: 4, flexWrap: "wrap" } },
				react.createElement("button", { type: "button", onClick: onSave, disabled: saving, style: importBtnStyle }, saving ? "保存中…" : "保存"),
				message ? react.createElement("span", { style: message.ok ? importOkStyle : importErrStyle, role: message.ok ? "status" : "alert" }, message.text) : null,
				react.createElement("span", { style: importHintStyle }, "写入 settings.yaml(dsh-vision 分节),热生效")
			));
			return react.createElement("div", { style: { display: "flex", flexDirection: "column", gap: 8, marginTop: 6 } }, cells);
		}

		function SelfPluginCard({ entry, expanded, onToggle }) {
			const open = expanded === entry.entryId;
			const title = entry.moduleName.replace(/^cordis:/, "").replace(/^dsh-(?:host-|client-)?/, "") || entry.moduleName;
			const phase = entry.fiberPhase === null ? "未观测" : entry.fiberPhase === "2" ? "运行中" : String(entry.fiberPhase);
			const tag = entry.enabled ? "已启用" : "已停用";
			return react.createElement("li", { style: selfTabCard },
				react.createElement("button", {
					type: "button",
					style: selfTabCardBtn,
					"aria-expanded": open,
					onClick: () => onToggle(entry.entryId)
				},
					react.createElement("strong", { style: selfTabTitle, title: entry.moduleName }, title),
					react.createElement("span", { style: selfTabTrail },
						entry.enabled ? react.createElement("span", { style: selfTabDot, title: phase }) : null,
						react.createElement("span", { style: selfTabTag }, tag),
						react.createElement("span", { "aria-hidden": true, style: { color: "var(--dsw-alias-label-secondary)", fontSize: 12 } }, open ? "▴" : "▾")
					)
				),
				open ? react.createElement("div", { style: selfTabDetails },
					react.createElement("div", null, "模块: ", react.createElement("code", { style: selfTabCode }, entry.moduleName)),
					react.createElement("div", null, "条目: ", react.createElement("code", { style: selfTabCode }, entry.entryId)),
					react.createElement("div", null, "状态: ", phase),
					react.createElement("div", null, "可编辑: ", entry.editable ? "是(带配置项)" : "否"),
					(entry.entryId === "include:dsh-vision" || entry.entryId === "dsh-vision") ? react.createElement(VisionConfigPanel, null) : null
				) : null
			);
		}

		function SelfAddedPluginsTab() {
			const [state, setState] = react.useState({ status: "loading" });
			const [expanded, setExpanded] = react.useState(null);
			const [view, setView] = react.useState("editable");
			const [request, setRequest] = react.useState(0);
			// —— 导入插件 状态 ——
			const [importing, setImporting] = react.useState(false);
			const [importResult, setImportResult] = react.useState(null); // {ok, name, error}
			const fileRef = react.useRef(null);
			// —— 热更新 状态 ——
			const [updateState, setUpdateState] = react.useState(null); // {phase:'checking'|'ready'|'applying', data}
			const checkUpdate = () => {
				setUpdateState({ phase: "checking" });
				fetch("/api/dsh-update-check").then((r) => r.json()).then((res) => {
					if (res && res.ok) setUpdateState({ phase: "ready", data: res });
					else setUpdateState({ phase: "ready", data: { checkFailed: true, error: (res && res.error) || "检查失败" } });
				}, () => { setUpdateState({ phase: "ready", data: { checkFailed: true, error: "请求失败" } }); });
			};
			const applyUpdate = () => {
				setUpdateState({ phase: "applying" });
				fetch("/api/dsh-update-apply", { method: "POST" }).then((r) => r.json()).then((res) => {
					if (res && res.ok) setUpdateState({ phase: "ready", data: { updated: true, sha: res.sha } });
					else setUpdateState({ phase: "ready", data: { error: (res && res.error) || "更新失败" } });
				}, () => { setUpdateState({ phase: "ready", data: { error: "请求失败" } }); });
			};
			// 进入页面自动检查一次更新
			react.useEffect(() => {
				checkUpdate();
			}, []);
			react.useEffect(() => {
				let current = true;
				fetch("/api/dsh-plugins").then((r) => r.json()).then((res) => {
					if (current) setState(res && res.ok ? { status: "ready", entries: res.entries || [] } : { status: "error" });
				}, () => { if (current) setState({ status: "error" }); });
				return () => { current = false; };
			}, [request]);
			const retry = () => { setState({ status: "loading" }); setRequest((v) => v + 1); };
			const openPicker = () => { if (fileRef.current) fileRef.current.click(); };
			const importingRef = react.useRef(false);
			const onFileChange = (e) => {
				const file = e.target && e.target.files && e.target.files[0];
				// 每次选完重置 input,保证同一文件可重复导入
				if (e.target) e.target.value = "";
				if (!file) return;
				// 前置大小检查:host 上限 64MB base64(约 48MB 原始),浏览器先拦避免撑爆内存
				if (file.size > 48 * 1024 * 1024) {
					setImportResult({ ok: false, error: "文件过大(上限约 48MB)" });
					return;
				}
				// 同步重入防护:state 更新是异步的,用 ref 拦极短窗口内的双击
				if (importingRef.current) return;
				importingRef.current = true;
				setImporting(true);
				setImportResult(null);
				const reader = new FileReader();
				reader.onload = () => {
					const b64 = typeof reader.result === "string" ? reader.result.split(",", 2)[1] || reader.result : "";
					const fileName = file.name || "plugin.zip";
					const ctrl = typeof AbortController !== "undefined" ? new AbortController() : null;
					const timer = ctrl ? setTimeout(() => ctrl.abort(), 60000) : null;
					fetch("/api/dsh-plugin-import", {
						method: "POST",
						headers: { "content-type": "application/json" },
						body: JSON.stringify({ fileName: fileName, dataBase64: b64 }),
						signal: ctrl ? ctrl.signal : undefined
					}).then((r) => r.json()).then((res) => {
						importingRef.current = false;
						setImporting(false);
						if (res && res.ok) {
							setImportResult({ ok: true, name: res.name });
							setView("editable");
							setRequest((v) => v + 1); // 刷新列表(新插件重启后才挂载,列表不一定出现)
						} else {
							setImportResult({ ok: false, error: (res && res.error) || "未知错误" });
						}
					}, (err) => {
						importingRef.current = false;
						setImporting(false);
						setImportResult({ ok: false, error: (err && err.name === "AbortError") ? "导入超时(60 秒),请重试" : ("请求失败: " + String(err && err.message ? err.message : err)) });
					}).then(() => { if (timer) clearTimeout(timer); });
				};
				reader.onerror = () => {
					importingRef.current = false;
					setImporting(false);
					setImportResult({ ok: false, error: "文件读取失败" });
				};
				reader.readAsDataURL(file);
			};
			if (state.status === "loading") return react.createElement("div", { style: selfTabSection }, react.createElement("p", { style: selfTabStatus }, "加载中…"));
			if (state.status === "error") return react.createElement("div", { style: selfTabSection },
				react.createElement("p", { style: selfTabStatus, role: "alert" }, "加载失败"),
				react.createElement("button", { type: "button", onClick: retry, style: btnStyle }, "重试")
			);
			const entries = state.entries;
			const editableGroup = entries.filter((e) => e.editable);
			const fixedGroup = entries.filter((e) => !e.editable);
			const renderGroup = (title, list) => {
				const cells = [];
				cells.push(react.createElement("div", { key: "gt" + title, style: selfTabGroupTitle },
					react.createElement("span", null, title),
					react.createElement("span", { style: selfTabCount }, String(list.length))
				));
				if (list.length === 0) {
					cells.push(react.createElement("p", { key: "ge" + title, style: selfTabStatus }, "无"));
				} else {
					cells.push(react.createElement("ul", { key: "gl" + title, style: selfTabCards },
						list.map((entry) => react.createElement(SelfPluginCard, {
							key: entry.entryId,
							entry: entry,
							expanded: expanded,
							onToggle: (id) => setExpanded((cur) => (cur === id ? null : id))
						}))
					));
				}
				return cells;
			};
			const cells = [];
			cells.push(react.createElement("div", { key: "head", style: selfTabHeading },
				react.createElement("h3", { style: { margin: 0, fontSize: 14, fontWeight: 600 } }, "额外插件"),
				react.createElement("span", { style: selfTabCount }, String(entries.length))
			));
			cells.push(react.createElement("p", { key: "note", style: selfTabStatus }, "“插件配置”“插件清单”为官方自带插件,此处仅列出额外插件。"));
			// —— 导入插件 区(顶部) ——
			cells.push(react.createElement("div", { key: "import-row", style: importRowStyle },
				react.createElement("button", { type: "button", style: importBtnStyle, onClick: openPicker, disabled: importing }, importing ? "导入中…" : "导入插件"),
				react.createElement("button", { type: "button", style: importBtnStyle, onClick: checkUpdate, disabled: updateState && (updateState.phase === "checking" || updateState.phase === "applying") }, updateState && updateState.phase === "checking" ? "检查中…" : "检查更新"),
				react.createElement("p", { key: "import-hint", style: importHintStyle }, "导入 .zip/.tgz 插件包;检查更新 = 从 GitHub 拉取 uiopt 最新代码(热更新)")
			));
			cells.push(react.createElement("input", {
				key: "import-file",
				ref: fileRef,
				type: "file",
				accept: ".zip,.tgz,.tar.gz",
				style: { display: "none" },
				onChange: onFileChange
			}));
			if (importResult && importResult.ok) {
				cells.push(react.createElement("p", { key: "import-ok", style: importOkStyle, role: "status" },
					"成功:插件 “" + importResult.name + "” 已安装,重启 dsh 后它将出现在下方列表。"
				));
			} else if (importResult && importResult.error) {
				cells.push(react.createElement("p", { key: "import-err", style: importErrStyle, role: "alert" },
					"失败:" + importResult.error
				));
			} else if (importing) {
				cells.push(react.createElement("p", { key: "import-ing", style: importStatusStyle, role: "status" }, "导入中…"));
			}
			// —— 热更新 状态区 ——
			if (updateState && updateState.phase === "applying") {
				cells.push(react.createElement("p", { key: "upd-ing", style: importStatusStyle, role: "status" }, "更新中(从 GitHub 下载最新代码)…"));
			} else if (updateState && updateState.phase === "ready" && updateState.data && updateState.data.updated) {
				cells.push(react.createElement("p", { key: "upd-ok", style: importOkStyle, role: "status" },
					"更新成功!已同步到 GitHub 最新代码(" + (updateState.data.sha ? String(updateState.data.sha).slice(0, 7) : "latest") + ")。请重启 dsh(host 改动)+ 刷新页面(client 改动)后生效。"
				));
			} else if (updateState && updateState.phase === "ready" && updateState.data && updateState.data.hasUpdate) {
				const d = updateState.data.latest && updateState.data.latest.date ? String(updateState.data.latest.date).slice(0, 10) : "";
				cells.push(react.createElement("div", { key: "upd-new", style: importRowStyle },
					react.createElement("p", { key: "upd-new-t", style: importStatusStyle, role: "status" }, "发现新版本" + (d ? "(GitHub 最新提交 " + d + ")" : "") + ",当前已落后。" ),
					react.createElement("button", { key: "upd-new-b", type: "button", style: btnStyle, onClick: applyUpdate }, "更新到最新")
				));
			} else if (updateState && updateState.phase === "ready" && updateState.data && !updateState.data.checkFailed) {
				cells.push(react.createElement("p", { key: "upd-ok", style: importStatusStyle, role: "status" }, "uiopt 已是最新(GitHub master 同步)✓"));
			} else if (updateState && updateState.phase === "ready" && updateState.data && updateState.data.checkFailed) {
				cells.push(react.createElement("div", { key: "upd-err", style: importRowStyle },
					react.createElement("p", { key: "upd-err-t", style: importErrStyle, role: "alert" }, "检查更新失败:" + (updateState.data.error || "未知错误")),
					react.createElement("button", { key: "upd-err-b", type: "button", style: btnStyle, onClick: checkUpdate }, "重试")
				));
			}
			if (entries.length === 0) {
				cells.push(react.createElement("p", { key: "empty", style: selfTabStatus }, "暂无额外插件"));
			} else {
				const segBtn = (active) => ({
					...btnStyle,
					fontSize: 13,
					padding: "7px 18px",
					lineHeight: "20px",
					borderRadius: 8,
					border: "1.5px solid " + (active ? "var(--dsw-alias-brand-primary)" : "var(--dsw-alias-border-l2)"),
					fontWeight: active ? 600 : 400,
					color: active ? "var(--dsw-alias-label-primary)" : "var(--dsw-alias-label-secondary)"
				});
				cells.push(react.createElement("div", { key: "seg", style: { display: "flex", gap: 8 } },
					react.createElement("button", { type: "button", style: segBtn(view === "editable"), onClick: () => setView("editable") }, "可配置插件"),
					react.createElement("button", { type: "button", style: segBtn(view === "fixed"), onClick: () => setView("fixed") }, "不可配置插件")
				));
				const list = view === "editable" ? editableGroup : fixedGroup;
				cells.push(react.createElement("div", { key: "group", style: selfTabSection },
					renderGroup(view === "editable" ? "可配置插件" : "不可配置插件", list)
				));
			}
			return react.createElement("div", { style: selfTabSection }, cells);
		}

		const entry = {
			name: "显示优化",
			inject: ["slots"],
			apply(ctx) {
				const modelDirectories = ctx.get("modelDirectories");
				ctx.slots.inject("shell.overlay", () => ctx.slots.register({
					name: "shell.overlay",
					id: "uiopt-float",
					order: 0,
					locale: NS
				}, (props) => react.createElement(FloatingWidget, {
					useSessions: props.useSessions,
					modelDirectories: modelDirectories
				})));
				ctx.slots.inject("conversation.chat.assistant-actions", () => ctx.slots.register({
					name: "conversation.chat.assistant-actions",
					id: "balance-cost",
					order: 20,
					locale: NS
				}, (props) => react.createElement(MessageCostAction, {
					messageId: props.messageId,
					useSession: props.useSession
				})));
				ctx.slots.inject("conversation.input.right", () => ctx.slots.register({
					name: "conversation.input.right",
					id: "provider-icon",
					order: 10,
					locale: NS
				}, (props) => react.createElement(ProviderIcon, {
					sessionId: props.sessionId,
					modelDirectories: modelDirectories
				})));
				ctx.slots.inject("settings.plugins.tab", () => ctx.slots.register({
					name: "settings.plugins.tab",
					id: "self",
					order: 20,
					label: "额外插件",
					locale: NS
				}, SelfAddedPluginsTab));
				// 注:第一个"插件配置"、第二个"插件清单"标签页保持官方原样(替换会破坏官方卡片渲染,故不替换)
			}
		};
		exports.default = entry;
		exports.name = entry.name;
		exports.inject = entry.inject;
		exports.apply = entry.apply;
		return module.exports;
	}
});
