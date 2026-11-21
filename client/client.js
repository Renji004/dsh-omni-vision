/**
 * dsh-omni-vision client half — hand-written module-loader factory bundle (no build
 * step). The loader table provides `react`; everything else is plain DOM.
 *
 * Registers a keyed `tool.call.toolview` entry for `eyes_render`: renders the
 * drawing commands on a <canvas> inside the conversation card, and while the
 * call is still running, serializes the canvas to PNG and POSTs it back to
 * `POST /eyes/render` (matched by the tool-call id) so the host tool can
 * resolve. Settled blocks (history replay) redraw without uploading.
 */
window.__ModuleLoader__.load({
	id: "dsh-omni-vision",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		const React = require("react");

		// ---- styles (injected once at materialization, like the built bundles) ----
		const CSS_TAG = "dsh-omni-vision/card.css";
		if (typeof document !== "undefined" && document.querySelector("style[data-plugin-css=" + JSON.stringify(CSS_TAG) + "]") === null) {
			const tag = document.createElement("style");
			tag.dataset.plugin = "dsh-omni-vision";
			tag.dataset.pluginCss = CSS_TAG;
			tag.textContent = [
				".dshEyes_card{flex-direction:column;gap:8px;display:flex;min-width:0}",
				".dshEyes_header{align-items:center;min-height:28px;gap:8px;display:flex}",
				".dshEyes_title{color:var(--dsw-alias-label-primary,#1f2328);font-size:13px;font-weight:600;line-height:20px;flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
				".dshEyes_status{color:var(--dsw-alias-label-caption,#8a919c);font-size:11px;line-height:20px;flex:none}",
				".dshEyes_status[data-state=error]{color:var(--dsw-alias-state-error-primary,#d92d20)}",
				".dshEyes_status[data-state=ok]{color:var(--dsw-alias-state-success-primary,#12a150)}",
				".dshEyes_frame{border:1px solid var(--dsw-alias-border-l2,#e2e5ea);background:var(--dsw-alias-bg-base,#ffffff);border-radius:10px;padding:8px;min-width:0;overflow:hidden}",
				".dshEyes_canvas{display:block;max-width:100%;height:auto;border-radius:6px;background:#fff}",
				".dshEyes_note{color:var(--dsw-alias-label-tertiary,#9aa1ab);font-size:11px;line-height:16px}",
				".dshEyes_note[data-error=true]{color:var(--dsw-alias-state-error-primary,#d92d20)}",
				".dshEyes_pastebox{border:1px dashed var(--dsw-alias-border-l2,#c7ccd4);background:var(--dsw-alias-bg-base,#ffffff);border-radius:10px;padding:22px 16px;text-align:center;color:var(--dsw-alias-label-tertiary,#9aa1ab);font-size:12px;line-height:20px;min-width:0}",
				".dshEyes_pastebox[data-state=ok]{border-style:solid;border-color:var(--dsw-alias-state-success-primary,#12a150);color:var(--dsw-alias-state-success-primary,#12a150)}",
				".dshEyes_pastebox[data-state=error]{border-style:solid;border-color:var(--dsw-alias-state-error-primary,#d92d20);color:var(--dsw-alias-state-error-primary,#d92d20)}",
				".dshEyes_kbd{display:inline-block;border:1px solid var(--dsw-alias-border-l2,#c7ccd4);border-bottom-width:2px;border-radius:5px;padding:0 6px;font-size:11px;font-family:ui-monospace,Consolas,monospace}",
				".dshEyes_pastebox[data-state=live]{animation:dshEyes_pulse 1.6s ease-in-out infinite}",
				"@keyframes dshEyes_pulse{0%,100%{border-color:var(--dsw-alias-border-l2,#c7ccd4)}50%{border-color:var(--dsw-alias-brand-primary,#4b8bff)}}"
			].join("\n");
			document.head.appendChild(tag);
		}

		// ---- helpers ----
		function parseArgs(argsRaw) {
			if (typeof argsRaw !== "string" || argsRaw.trim() === "") return null;
			try {
				const parsed = JSON.parse(argsRaw);
				return typeof parsed === "object" && parsed !== null ? parsed : null;
			} catch {
				return null;
			}
		}

		function clampInt(value, min, max, fallback) {
			const n = Number(value);
			if (!Number.isFinite(n)) return fallback;
			return Math.max(min, Math.min(max, Math.round(n)));
		}

		function numOr(value, fallback) {
			const n = Number(value);
			return Number.isFinite(n) ? n : fallback;
		}

		function strOr(value, fallback) {
			return typeof value === "string" && value !== "" ? value : fallback;
		}

		// ---- text layout ----

		/** Per-draw measureText cache, keyed by the current font + the string. */
		const measureCache = new Map();

		function measure(c, text) {
			const key = c.font + "\u0000" + text;
			let width = measureCache.get(key);
			if (width === undefined) {
				width = c.measureText(text).width;
				measureCache.set(key, width);
			}
			return width;
		}

		const CJK_CHAR = /[\u1100-\u11ff\u2e80-\u9fff\uac00-\ud7af\uf900-\ufaff\ufe30-\ufe4f\uff00-\uffef]/;

		/** Greedy line breaking: latin on spaces, CJK anywhere. maxWidth that is
		 *  missing or <= 0 means "no wrapping". A single unbreakable run that
		 *  is wider than maxWidth is returned as-is (fillText squeezes it). */
		function wrapLine(c, text, maxWidth) {
			if (!(maxWidth > 0) || text === "") return [text];
			if (text.length > 800) return [text]; // pathological: keep the old squeeze
			if (measure(c, text) <= maxWidth) return [text];
			const out = [];
			let line = "";
			for (const ch of text) {
				const candidate = line + ch;
				if (line !== "" && measure(c, candidate) > maxWidth) {
					// Prefer the last space / CJK boundary inside the candidate.
					let cut = -1;
					for (let i = candidate.length - 1; i > 0; i--) {
						const prev = candidate[i - 1];
						if (prev === " " || CJK_CHAR.test(prev)) { cut = i; break; }
					}
					let head;
					let tail;
					if (cut > 0 && cut < candidate.length) {
						head = candidate.slice(0, cut);
						tail = candidate.slice(cut);
					} else {
						head = line;
						tail = ch;
					}
					out.push(head.replace(/[ \t]+$/, ""));
					line = tail.replace(/^[ \t]+/, "");
				} else {
					line = candidate;
				}
			}
			if (line !== "") out.push(line);
			return out.length > 0 ? out : [text];
		}

		/** Load every declared font face before painting so the PNG uses the real
		 *  glyphs (and real metrics) instead of a fallback face. */
		async function ensureFonts(commands) {
			if (typeof document === "undefined" || !document.fonts || typeof document.fonts.load !== "function") return;
			const specs = new Set();
			for (const cmd of commands) {
				if (cmd === null || typeof cmd !== "object" || cmd.op !== "text" || typeof cmd.text !== "string") continue;
				const size = Math.max(1, numOr(cmd.size, 16));
				specs.add(`${strOr(cmd.weight, "normal")} ${size}px ${strOr(cmd.font, "sans-serif")}`);
				if (specs.size >= 16) break;
			}
			await Promise.all([...specs].map((spec) => {
				try {
					return document.fonts.load(spec).catch(() => null);
				} catch {
					return null;
				}
			}));
		}

		// ---- pixel snapping (device grid) ----

		/** Current device-pixel-per-logical-pixel factor of the context. */
		function densityOf(c) {
			try {
				const m = c.getTransform();
				const d = Math.abs(m.a);
				return Number.isFinite(d) && d > 0 ? d : 1;
			} catch {
				return 1;
			}
		}

		/** Snap a stroke CENTER so both of its edges land on device-pixel
		 *  boundaries: a 1 px hairline at y=10.5 would otherwise be smeared
		 *  across two rows. Only used for axis-aligned edges. */
		function snapStroke(v, d, w) {
			const W = Math.max(1, Math.round(w * d));
			const snapped = (Math.round(v * d - W / 2) + W / 2) / d;
			return Number.isFinite(snapped) ? snapped : v;
		}

		// ---- text layout (shared by draw + stack/table measurement) ----

		/** Set the font and break the text into final lines. `fallbackMaxWidth`
		 *  is the width available from the container (stack); undfined means
		 *  "no wrapping unless maxWidth is given". */
		function textLayout(c, cmd, fallbackMaxWidth) {
			const text = String(cmd.text ?? "");
			const size = Math.max(1, numOr(cmd.size, 16));
			c.font = `${strOr(cmd.weight, "normal")} ${size}px ${strOr(cmd.font, "sans-serif")}`;
			const maxWidth = cmd.maxWidth !== undefined
				? Math.max(0, numOr(cmd.maxWidth, 0))
				: fallbackMaxWidth;
			const lines = [];
			for (const raw of text.split("\n")) {
				for (const piece of wrapLine(c, raw, maxWidth)) lines.push(piece);
			}
			return { text, lines, size, step: size * 1.25, maxWidth };
		}

		// ---- paint: gradients & shadows ----

		const GRADIENT_RE = /^(linear|radial)-gradient\((.*)\)$/i;

		/** Turn a CSS-ish gradient string into a CanvasGradient for `bbox`.
		 *  linear-gradient(<angle>deg?, stop, stop, ...) / radial-gradient(stop,...). */
		function gradientFor(c, value, bbox) {
			if (typeof value !== "string" || bbox === null || bbox === undefined) return null;
			const m = GRADIENT_RE.exec(value.trim());
			if (m === null) return null;
			const parts = m[2].split(",").map((s) => s.trim()).filter((s) => s !== "");
			if (parts.length === 0) return null;
			let angle = 180;
			if (/^-?[\d.]+(?:deg)?$/i.test(parts[0])) angle = parseFloat(parts.shift());
			const stops = parts.length > 0 ? parts : ["#ffffff"];
			const cx = bbox.x + bbox.w / 2;
			const cy = bbox.y + bbox.h / 2;
			let g;
			if (m[1].toLowerCase() === "radial") {
				g = c.createRadialGradient(cx, cy, 0, cx, cy, Math.max(1, Math.max(bbox.w, bbox.h) / 2));
			} else {
				const rad = (angle * Math.PI) / 180;
				const dx = Math.sin(rad);
				const dy = -Math.cos(rad);
				const len = Math.abs(bbox.w * dx) + Math.abs(bbox.h * dy) || 1;
				g = c.createLinearGradient(
					cx - (dx * len) / 2, cy - (dy * len) / 2,
					cx + (dx * len) / 2, cy + (dy * len) / 2
				);
			}
			for (let i = 0; i < stops.length; i++) {
				g.addColorStop(stops.length === 1 ? 0 : i / (stops.length - 1), stops[i]);
			}
			return g;
		}

		/** Resolve a paint value (solid color or gradient string) for a bbox. */
		function paint(c, value, bbox) {
			const g = gradientFor(c, value, bbox);
			return g === null ? value : g;
		}

		function bboxOfPoints(pts) {
			let minX = Infinity;
			let minY = Infinity;
			let maxX = -Infinity;
			let maxY = -Infinity;
			for (const p of pts) {
				if (p[0] < minX) minX = p[0];
				if (p[0] > maxX) maxX = p[0];
				if (p[1] < minY) minY = p[1];
				if (p[1] > maxY) maxY = p[1];
			}
			if (!Number.isFinite(minX)) return null;
			return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
		}

		/** Apply cmd.shadow ("dx dy blur color") for one command. */
		function applyShadow(c, value) {
			if (typeof value !== "string" || value.trim() === "") return false;
			const parts = value.trim().split(/\s+/);
			c.shadowColor = parts.length > 3 ? parts.slice(3).join(" ") : "rgba(0,0,0,0.25)";
			c.shadowOffsetX = numOr(parseFloat(parts[0]), 0);
			c.shadowOffsetY = numOr(parseFloat(parts[1]), 0);
			c.shadowBlur = Math.max(0, numOr(parseFloat(parts[2]), 0));
			return true;
		}

		function clearShadow(c) {
			c.shadowColor = "rgba(0,0,0,0)";
			c.shadowOffsetX = 0;
			c.shadowOffsetY = 0;
			c.shadowBlur = 0;
		}

		// ---- procedural field: value-noise fBm with domain warping ----

		function hash2(ix, iy, seed) {
			let h = (ix | 0) * 374761393 + (iy | 0) * 668265263 + (seed | 0) * 144269;
			h = (h ^ (h >> 13)) * 1274126177;
			h ^= h >> 16;
			return (h >>> 0) / 4294967295;
		}

		function smoothStep(t) {
			return t * t * (3 - 2 * t);
		}

		/** Value noise: smooth interpolation between hashed lattice corners. */
		function vnoise(x, y, seed) {
			const ix = Math.floor(x);
			const iy = Math.floor(y);
			const fx = smoothStep(x - ix);
			const fy = smoothStep(y - iy);
			const a = hash2(ix, iy, seed);
			const b = hash2(ix + 1, iy, seed);
			const c0 = hash2(ix, iy + 1, seed);
			const d = hash2(ix + 1, iy + 1, seed);
			const top = a + (b - a) * fx;
			const bottom = c0 + (d - c0) * fx;
			return top + (bottom - top) * fy;
		}

		function fbm(x, y, seed, octaves) {
			let sum = 0;
			let amp = 0.5;
			let norm = 0;
			let fx = x;
			let fy = y;
			for (let i = 0; i < octaves; i++) {
				sum += vnoise(fx, fy, seed + i * 101) * amp;
				norm += amp;
				amp *= 0.5;
				fx *= 2.03;
				fy *= 1.97;
			}
			return norm > 0 ? sum / norm : 0;
		}

		/** Resolve any CSS color to [r,g,b,a] via a 1x1 canvas probe. */
		let colorProbe = null;
		function resolveColor(value) {
			if (colorProbe === null) {
				const cv = document.createElement("canvas");
				cv.width = 1;
				cv.height = 1;
				colorProbe = cv.getContext("2d", { willReadFrequently: true });
			}
			colorProbe.clearRect(0, 0, 1, 1);
			colorProbe.fillStyle = "#000000";
			colorProbe.fillStyle = value;
			colorProbe.fillRect(0, 0, 1, 1);
			const p = colorProbe.getImageData(0, 0, 1, 1).data;
			return [p[0], p[1], p[2], p[3]];
		}

		/** Paint a procedural noise field (clouds / marble / smoke) into a rect. */
		function drawField(c, cmd) {
			const x = numOr(cmd.x, 0);
			const y = numOr(cmd.y, 0);
			const w = Math.max(1, numOr(cmd.w, 0));
			const h = Math.max(1, numOr(cmd.h, 0));
			const d = densityOf(c);
			const pw = Math.max(1, Math.round(w * d));
			const ph = Math.max(1, Math.round(h * d));
			const seed = Math.round(numOr(cmd.seed, 1));
			const cell = Math.max(2, numOr(cmd.cell, 48));
			const octaves = Math.max(1, Math.min(6, Math.round(numOr(cmd.octaves, 3))));
			const warp = Math.max(0, Math.min(2, numOr(cmd.warp, 0.6)));
			const palette = Array.isArray(cmd.palette) && cmd.palette.length >= 2
				? cmd.palette.map((v) => resolveColor(String(v)))
				: [[11, 16, 32, 255], [59, 47, 99, 255], [232, 168, 124, 255]];
			const off = document.createElement("canvas");
			off.width = pw;
			off.height = ph;
			const oc = off.getContext("2d");
			const img = oc.createImageData(pw, ph);
			const data = img.data;
			const invCell = 1 / (cell * d);
			let p = 0;
			for (let py = 0; py < ph; py++) {
				const yv = py * invCell;
				for (let px = 0; px < pw; px++) {
					const xv = px * invCell;
					let n;
					if (warp > 0) {
						const wx = fbm(xv * 1.7 + 11.3, yv * 1.7 + 3.9, seed + 500, 2);
						const wy = fbm(xv * 1.7 + 41.7, yv * 1.7 + 27.1, seed + 900, 2);
						n = fbm(xv + (wx - 0.5) * warp * 2.5, yv + (wy - 0.5) * warp * 2.5, seed, octaves);
					} else {
						n = fbm(xv, yv, seed, octaves);
					}
					const n0 = n;
					// fBm clusters around 0.5; stretch it so the palette endpoints get used
					const n1 = (n0 - 0.5) * 1.7 + 0.5;
					const t = n1 < 0 ? 0 : n1 > 1 ? 1 : n1;
					const pos = t * (palette.length - 1);
					const i = Math.min(palette.length - 2, Math.floor(pos));
					const f = pos - i;
					const c0 = palette[i];
					const c1 = palette[i + 1];
					data[p++] = c0[0] + (c1[0] - c0[0]) * f;
					data[p++] = c0[1] + (c1[1] - c0[1]) * f;
					data[p++] = c0[2] + (c1[2] - c0[2]) * f;
					data[p++] = c0[3] + (c1[3] - c0[3]) * f;
				}
			}
			oc.putImageData(img, 0, 0);
			c.drawImage(off, x, y, w, h);
		}

		// ---- plot: y = f(x) ----

		const fnCache = new Map();

		/** Compile an expression whose single free variable is `param`. */
		function compileWith(expr, param) {
			if (typeof expr !== "string" || expr.trim() === "") return null;
			const key = param + "\u0000" + expr;
			let fn = fnCache.get(key);
			if (fn !== undefined) return fn;
			try {
				fn = new Function(param, `"use strict";
const {abs,acos,asin,atan,atan2,cbrt,ceil,cos,cosh,exp,floor,hypot,log,log10,log2,max,min,pow,round,sign,sin,sinh,sqrt,tan,tanh,trunc,PI,E} = Math;
return (${expr});`);
			} catch {
				fn = null;
			}
			fnCache.set(key, fn);
			return fn;
		}

		/** Compile an expression in x with Math in scope. Null on syntax error. */
		function compileFn(expr) {
			return compileWith(expr, "x");
		}

		/** Sample y = f(x) over the data domain and stroke it inside the box. */
		function drawPlot(c, cmd) {
			const fn = compileFn(cmd.fn);
			if (fn === null) return;
			const boxX = numOr(cmd.x, 0);
			const boxY = numOr(cmd.y, 0);
			const boxW = Math.max(1, numOr(cmd.w, 100));
			const boxH = Math.max(1, numOr(cmd.h, 100));
			const x0 = numOr(cmd.x0, -1);
			const x1 = numOr(cmd.x1, 1);
			const y0 = numOr(cmd.y0, -1);
			const y1 = numOr(cmd.y1, 1);
			const from = numOr(cmd.from, x0);
			const to = numOr(cmd.to, x1);
			const span = x1 - x0;
			const vspan = y1 - y0;
			const sampleSpan = to - from;
			if (span === 0 || vspan === 0 || sampleSpan === 0) return;
			const samples = Math.max(2, Math.min(4000, Math.round(numOr(cmd.samples, 300))));
			const points = [];
			for (let i = 0; i <= samples; i++) {
				const px = from + (sampleSpan * i) / samples;
				let py;
				try {
					py = fn(px);
				} catch {
					py = NaN;
				}
				if (typeof py !== "number" || !Number.isFinite(py)) {
					points.push(null);
					continue;
				}
				points.push([boxX + ((px - x0) / span) * boxW, boxY + boxH - ((py - y0) / vspan) * boxH]);
			}
			const fill = typeof cmd.fill === "string" && cmd.fill !== "" ? cmd.fill : null;
			c.beginPath();
			let started = false;
			let first = null;
			let last = null;
			for (const pt of points) {
				if (pt === null) {
					started = false;
					continue;
				}
				if (!started) {
					c.moveTo(pt[0], pt[1]);
					started = true;
					if (first === null) first = pt;
				} else {
					c.lineTo(pt[0], pt[1]);
				}
				last = pt;
			}
			if (fill !== null && first !== null && last !== null) {
				c.lineTo(last[0], boxY + boxH);
				c.lineTo(first[0], boxY + boxH);
				c.closePath();
				c.fillStyle = paint(c, fill, { x: boxX, y: boxY, w: boxW, h: boxH });
				c.fill();
			}
			applyStroke(c, cmd, "#111827", { x: boxX, y: boxY, w: boxW, h: boxH });
			c.stroke();
		}

		// ---- coordinate system ----

		/** Shared data-space viewport for plot/grid/curve: pixel box + data range. */
		function dataView(cmd) {
			const x = numOr(cmd.x, 0);
			const y = numOr(cmd.y, 0);
			const w = Math.max(1, numOr(cmd.w, 100));
			const h = Math.max(1, numOr(cmd.h, 100));
			const x0 = numOr(cmd.x0, -1);
			const x1 = numOr(cmd.x1, 1);
			const y0 = numOr(cmd.y0, -1);
			const y1 = numOr(cmd.y1, 1);
			const span = x1 - x0;
			const vspan = y1 - y0;
			if (!(span !== 0 && vspan !== 0)) return null;
			return {
				x, y, w, h, x0, x1, y0, y1, span, vspan,
				sx: (v) => x + ((v - x0) / span) * w,
				sy: (v) => y + h - ((v - y0) / vspan) * h,
			};
		}

		/** 1-2-5 tick step: the "human" number closest to range/target. */
		function niceStep(range, target) {
			if (!(range > 0) || !(target > 0)) return 1;
			// Pick the 1-2-5-10 candidate whose tick COUNT sits closest to the
			// target (log distance). Rounding raw up instead over-shoots badly for
			// ranges like 12 with target 5 (5 -> only 3 ticks instead of 6).
			const raw = range / target;
			const mag = Math.pow(10, Math.floor(Math.log10(raw)));
			let best = 1;
			let bestErr = Infinity;
			for (const m of [1, 2, 5, 10]) {
				const count = range / (mag * m);
				const err = Math.abs(Math.log(count / target));
				if (err < bestErr - 1e-12) {
					bestErr = err;
					best = m;
				}
			}
			return mag * best;
		}

		/** Tick label text; trims float noise and uses exponent notation at the extremes. */
		function formatTick(v, step) {
			if (Math.abs(v) < 1e-12) return "0";
			if (Math.abs(v) >= 1e6 || Math.abs(v) < 1e-4) return v.toExponential(1).replace("e+", "e");
			const digits = Math.max(0, Math.min(6, -Math.floor(Math.log10(Math.abs(step)))));
			let s = v.toFixed(digits);
			if (s.indexOf(".") >= 0) s = s.replace(/0+$/, "").replace(/\.$/, "");
			return s === "-0" ? "0" : s;
		}

		/** Draw grid lines, zero axes, arrow heads and tick labels for a data box. */
		function drawGrid(c, cmd) {
			const v = dataView(cmd);
			if (v === null) return;
			const d = densityOf(c);
			const gridColor = paint(c, strOr(cmd.grid, "rgba(148,163,184,0.32)"), null);
			const axisColor = paint(c, strOr(cmd.color, "#64748b"), null);
			const gridW = Math.max(0.5, numOr(cmd.gridWidth, 1));
			const target = Math.max(0, Math.round(numOr(cmd.ticks, 0)));
			const autoX = Math.max(2, Math.min(24, Math.round(v.w / 90)));
			const autoY = Math.max(2, Math.min(24, Math.round(v.h / 90)));
			const tx = target > 0 ? Math.max(2, Math.min(40, target)) : autoX;
			const ty = target > 0 ? tx : autoY;
			const fixedX = numOr(cmd.stepX, 0);
			const fixedY = numOr(cmd.stepY, 0);
			const stepX = fixedX > 0 ? fixedX : niceStep(v.span, tx);
			const stepY = fixedY > 0 ? fixedY : niceStep(v.vspan, ty);
			if (!(stepX > 0) || !(stepY > 0)) return;

			// Grid lines: snapped so 1 px lines stay crisp at any supersampling.
			c.setLineDash([]);
			c.lineCap = "butt";
			c.lineWidth = gridW;
			c.strokeStyle = gridColor;
			c.beginPath();
			for (let i = Math.ceil(v.x0 / stepX - 1e-9); i * stepX <= v.x1 + 1e-9; i++) {
				const px = snapStroke(v.sx(i * stepX), d, gridW);
				c.moveTo(px, v.y);
				c.lineTo(px, v.y + v.h);
			}
			for (let j = Math.ceil(v.y0 / stepY - 1e-9); j * stepY <= v.y1 + 1e-9; j++) {
				const py = snapStroke(v.sy(j * stepY), d, gridW);
				c.moveTo(v.x, py);
				c.lineTo(v.x + v.w, py);
			}
			c.stroke();

			// Zero axes (only when zero is inside the viewport).
			const xAxis = v.y0 <= 0 && v.y1 >= 0;
			const yAxis = v.x0 <= 0 && v.x1 >= 0;
			c.lineWidth = 1;
			c.strokeStyle = axisColor;
			if (xAxis || yAxis) {
				c.beginPath();
				if (xAxis) {
					const py = snapStroke(v.sy(0), d, 1);
					c.moveTo(v.x, py);
					c.lineTo(v.x + v.w, py);
				}
				if (yAxis) {
					const px = snapStroke(v.sx(0), d, 1);
					c.moveTo(px, v.y);
					c.lineTo(px, v.y + v.h);
				}
				c.stroke();
			}
			const arrow = cmd.arrows !== false && v.w >= 28 && v.h >= 28;
			c.fillStyle = axisColor;
			if (arrow && xAxis) {
				const py = v.sy(0);
				const ex = v.x + v.w;
				c.beginPath();
				c.moveTo(ex - 2, py);
				c.lineTo(ex - 10, py - 4);
				c.lineTo(ex - 10, py + 4);
				c.closePath();
				c.fill();
			}
			if (arrow && yAxis) {
				const px = v.sx(0);
				const ey = v.y;
				c.beginPath();
				c.moveTo(px, ey + 2);
				c.lineTo(px - 4, ey + 10);
				c.lineTo(px + 4, ey + 10);
				c.closePath();
				c.fill();
			}

			if (cmd.labels === false) return;
			const size = Math.max(7, numOr(cmd.size, 12));
			const pad = Math.max(5, Math.round(size * 0.55));
			c.font = `${size}px ${strOr(cmd.font, "ui-sans-serif, system-ui, sans-serif")}`;
			c.fillStyle = axisColor;
			c.textBaseline = "middle";

			// Tick labels live OUTSIDE the data box, in the margin, like a normal
			// chart: the plot area is for data, the scale belongs to the frame.
			// Inside placement is only the fallback when the canvas edge is near.
			const ticksX = [];
			for (let i = Math.ceil(v.x0 / stepX - 1e-9); i * stepX <= v.x1 + 1e-9; i++) {
				const val = i * stepX;
				const px = v.sx(val);
				if (px < v.x - 1 || px > v.x + v.w + 1) continue;
				ticksX.push({ px, text: formatTick(val, stepX) });
			}
			const ticksY = [];
			for (let j = Math.ceil(v.y0 / stepY - 1e-9); j * stepY <= v.y1 + 1e-9; j++) {
				const val = j * stepY;
				// The origin is labelled once, by the x axis, so no doubled "0".
				if (yAxis && Math.abs(val) < stepY * 1e-6) continue;
				ticksY.push({ py: v.sy(val), text: formatTick(val, stepY) });
			}
			const canvasW = c.canvas ? c.canvas.width / d : v.x + v.w + 400;
			const canvasH = c.canvas ? c.canvas.height / d : v.y + v.h + 400;
			const widestY = ticksY.reduce((m, t) => Math.max(m, t.text.length * size * 0.62), 0);
			// A zero line strictly INSIDE the plot keeps its labels beside it; a
			// zero that is just the left/bottom edge is a normal axis and gets
			// its labels in the margin. (x0: 0 must not mean "labels inside".)
			const yAxisInside = v.x0 < -1e-9 && v.x1 > 1e-9;
			const xAxisInside = v.y0 < -1e-9 && v.y1 > 1e-9;
			const yOutside = !yAxisInside && v.x - pad - widestY >= 0;
			const xOutside = !xAxisInside && canvasH - (v.y + v.h) >= size + pad + 2;

			let labelY;
			if (xAxisInside) labelY = v.sy(0) + pad + size * 0.5;
			else if (xOutside) labelY = v.y + v.h + pad + size * 0.5;
			else labelY = v.y + v.h - pad - size * 0.5;
			for (const t of ticksX) {
				const half = t.text.length * size * 0.31;
				let tx = t.px;
				let align = "center";
				if (tx - half < 2) {
					tx = 2;
					align = "left";
				} else if (tx + half > canvasW - 2) {
					tx = canvasW - 2;
					align = "right";
				}
				c.textAlign = align;
				c.fillText(t.text, tx, labelY);
			}
			c.textAlign = yAxisInside || !yOutside ? "left" : "right";
			const labelX = yAxisInside ? v.sx(0) + pad : yOutside ? v.x - pad : v.x + 4;
			for (const t of ticksY) {
				// Clamp so the top/bottom tick is nudged inside, never dropped.
				const py = Math.max(v.y + size * 0.5, Math.min(v.y + v.h - size * 0.5, t.py));
				c.fillText(t.text, labelX, py);
			}
		}

		/** Parametric curve (x(t), y(t)) with adaptive subdivision by flatness. */
		function drawCurve(c, cmd) {
			const fx = compileWith(cmd.fx, "t");
			const fy = compileWith(cmd.fy, "t");
			if (fx === null || fy === null) return;
			const v = dataView(cmd);
			if (v === null) return;
			const t0 = numOr(cmd.t0, 0);
			const t1 = numOr(cmd.t1, Math.PI * 2);
			if (!(t1 > t0)) return;
			const base = Math.max(2, Math.min(4000, Math.round(numOr(cmd.samples, 96))));
			const tol = Math.max(0.05, numOr(cmd.tolerance, 0.35));
			const spanT = t1 - t0;
			const minDt = spanT * 1e-6;
			const toScreen = (t) => {
				let x;
				let y;
				try {
					x = fx(t);
					y = fy(t);
				} catch {
					return null;
				}
				if (typeof x !== "number" || typeof y !== "number" || !Number.isFinite(x) || !Number.isFinite(y)) return null;
				return [v.sx(x), v.sy(y)];
			};
			const pts = [];
			// Flatness test: distance of the midpoint sample from the chord. Split
			// while it exceeds `tol` px, so round shapes get detail and straight
			// runs stay cheap (what plotters do instead of brute sampling).
			const walk = (ta, pa, tb, pb, depth) => {
				if (depth < 10 && tb - ta > minDt) {
					const tm = (ta + tb) / 2;
					const pm = toScreen(tm);
					if (pm === null) {
						pts.push(null);
						pts.push(pb);
						return;
					}
					const dx = pb[0] - pa[0];
					const dy = pb[1] - pa[1];
					const len2 = dx * dx + dy * dy;
					let dist;
					if (len2 < 1e-9) {
						dist = Math.hypot(pm[0] - pa[0], pm[1] - pa[1]);
					} else {
						let u = ((pm[0] - pa[0]) * dx + (pm[1] - pa[1]) * dy) / len2;
						u = u < 0 ? 0 : u > 1 ? 1 : u;
						dist = Math.hypot(pm[0] - (pa[0] + u * dx), pm[1] - (pa[1] + u * dy));
					}
					if (dist > tol) {
						walk(ta, pa, tm, pm, depth + 1);
						walk(tm, pm, tb, pb, depth + 1);
						return;
					}
				}
				pts.push(pb);
			};
			let prev = toScreen(t0);
			pts.push(prev === null ? null : prev);
			for (let i = 1; i <= base; i++) {
				const tb = t0 + (spanT * i) / base;
				const pb = toScreen(tb);
				if (pb === null) {
					pts.push(null);
				} else if (prev === null) {
					pts.push(pb);
				} else {
					walk(t0 + (spanT * (i - 1)) / base, prev, tb, pb, 0);
				}
				prev = pb;
				if (pts.length > 24000) break;
			}
			c.beginPath();
			let started = false;
			for (const pt of pts) {
				if (pt === null) {
					started = false;
					continue;
				}
				if (!started) {
					c.moveTo(pt[0], pt[1]);
					started = true;
				} else {
					c.lineTo(pt[0], pt[1]);
				}
			}
			if (cmd.closed === true) c.closePath();
			const fill = typeof cmd.fill === "string" && cmd.fill !== "" ? cmd.fill : null;
			if (fill !== null) {
				c.fillStyle = paint(c, fill, { x: v.x, y: v.y, w: v.w, h: v.h });
				c.fill();
			}
			applyStroke(c, cmd, "#111827", { x: v.x, y: v.y, w: v.w, h: v.h });
			c.stroke();
		}

		/** Film-grain overlay across the whole canvas. */		function applyGrain(canvas, amount) {
			const a = Math.max(0, Math.min(1, numOr(amount, 0)));
			if (a <= 0) return;
			const w = canvas.width;
			const h = canvas.height;
			const off = document.createElement("canvas");
			off.width = w;
			off.height = h;
			const oc = off.getContext("2d");
			const img = oc.createImageData(w, h);
			const data = img.data;
			const alpha = Math.round(a * 52);
			let p = 0;
			for (let i = 0; i < w * h; i++) {
				const v = 128 + (Math.random() - 0.5) * 255;
				data[p++] = v;
				data[p++] = v;
				data[p++] = v;
				data[p++] = alpha;
			}
			oc.putImageData(img, 0, 0);
			const c = canvas.getContext("2d");
			c.save();
			c.setTransform(1, 0, 0, 1, 0, 0);
			c.globalCompositeOperation = "overlay";
			c.globalAlpha = 1;
			c.filter = "none";
			c.drawImage(off, 0, 0);
			c.restore();
		}

		function roundRectPath(c, x, y, w, h, r) {
			// Canonicalize direction: negative width/height must still trace the
			// same rectangle, otherwise arcTo sweeps the wrong way and the path
			// self-intersects.
			if (w < 0) { x += w; w = -w; }
			if (h < 0) { y += h; h = -h; }
			const rr = Math.max(0, Math.min(r, w / 2, h / 2));
			c.beginPath();
			c.moveTo(x + rr, y);
			c.lineTo(x + w - rr, y);
			c.arcTo(x + w, y, x + w, y + rr, rr);
			c.lineTo(x + w, y + h - rr);
			c.arcTo(x + w, y + h, x + w - rr, y + h, rr);
			c.lineTo(x + rr, y + h);
			c.arcTo(x, y + h, x, y + h - rr, rr);
			c.lineTo(x, y + rr);
			c.arcTo(x, y, x + rr, y, rr);
			c.closePath();
		}

		/** Apply the shared stroke style (color/width/dash) for one command. */
		function applyStroke(c, cmd, fallbackColor, bbox) {
			const dash = Array.isArray(cmd.dash) && cmd.dash.length > 0
				? cmd.dash.map((v) => Math.max(0, numOr(v, 0)))
				: [];
			c.setLineDash(dash);
			c.strokeStyle = paint(c, strOr(cmd.color, strOr(cmd.stroke, fallbackColor)), bbox);
			c.lineWidth = Math.max(0.1, numOr(cmd.width, numOr(cmd.strokeWidth, 2)));
			c.lineCap = strOr(cmd.cap, "butt");
			c.lineJoin = strOr(cmd.join, "miter");
		}

		/** Whether a command asks for a stroke at all (explicit stroke or width). */
		function wantsStroke(cmd) {
			return (typeof cmd.stroke === "string" && cmd.stroke !== "")
				|| cmd.width !== undefined
				|| cmd.strokeWidth !== undefined;
		}

		/** Normalize a points list ([x,y] pairs or {x,y} objects). */
		function readPoints(raw) {
			const pts = [];
			if (!Array.isArray(raw)) return pts;
			for (const p of raw) {
				if (Array.isArray(p) && p.length >= 2) pts.push([numOr(p[0], 0), numOr(p[1], 0)]);
				else if (p !== null && typeof p === "object") pts.push([numOr(p.x, 0), numOr(p.y, 0)]);
			}
			return pts;
		}

		function drawShape(c, cx, cy, rx, ry, cmd) {
			const fill = typeof cmd.fill === "string" && cmd.fill !== "" ? cmd.fill : null;
			const stroke = typeof cmd.stroke === "string" && cmd.stroke !== "" ? cmd.stroke : null;
			const bbox = { x: cx - Math.abs(rx), y: cy - Math.abs(ry), w: Math.abs(rx) * 2, h: Math.abs(ry) * 2 };
			c.beginPath();
			c.ellipse(cx, cy, Math.max(0, rx), Math.max(0, ry), 0, 0, Math.PI * 2);
			if (fill !== null) {
				c.fillStyle = paint(c, fill, bbox);
				c.fill();
			}
			if (stroke !== null) {
				applyStroke(c, cmd, "#000000", bbox);
				c.stroke();
			}
		}

		/** Draw one command; bad commands are skipped, never fatal. */
		function drawCommand(c, cmd) {
			if (cmd === null || typeof cmd !== "object" || typeof cmd.op !== "string") return;
			// Paint state is per command: opacity covers the whole command, and the
			// dash pattern is opt-in so it never leaks into the next shape.
			c.globalAlpha = Math.max(0, Math.min(1, numOr(cmd.opacity, 1)));
			c.setLineDash([]);
			const shadowed = applyShadow(c, cmd.shadow);
			const blend = strOr(cmd.blend, "");
			if (blend !== "") c.globalCompositeOperation = blend;
			const filterValue = strOr(cmd.filter, "");
			if (filterValue !== "") c.filter = filterValue;
			switch (cmd.op) {
				case "text": {
					const t = textLayout(c, cmd);
					if (t.text === "") break;
					c.fillStyle = paint(c, strOr(cmd.color, "#000000"), null);
					c.textAlign = strOr(cmd.align, "left");
					const x = numOr(cmd.x, 0);
					const y = numOr(cmd.y, 0);
					// Anchor the VISUAL top of the first line on y. textBaseline
					// "top" is engine-inconsistent: some engines align the font's
					// em-box top, which sits above the glyphs and pushes text below
					// the requested y. Instead draw on the alphabetic baseline at
					// y + actualBoundingBoxAscent, so the glyph top lands exactly
					// on y everywhere (metrics measured from the same baseline).
					let glyphAscent = null;
					try {
						let probe = "Ag";
						for (const line of t.lines) { if (line !== "") { probe = line; break; } }
						const m = c.measureText(probe);
						if (Number.isFinite(m.actualBoundingBoxAscent)) glyphAscent = m.actualBoundingBoxAscent;
					} catch {
						// metrics unavailable: fall through to plain "top" anchoring
					}
					if (glyphAscent !== null) {
						c.textBaseline = "alphabetic";
						for (let i = 0; i < t.lines.length; i++) {
							const baselineY = y + glyphAscent + i * t.step;
							if (t.maxWidth === undefined) c.fillText(t.lines[i], x, baselineY);
							else c.fillText(t.lines[i], x, baselineY, t.maxWidth);
						}
					} else {
						c.textBaseline = "top";
						for (let i = 0; i < t.lines.length; i++) {
							const lineY = y + i * t.step;
							if (t.maxWidth === undefined) c.fillText(t.lines[i], x, lineY);
							else c.fillText(t.lines[i], x, lineY, t.maxWidth);
						}
					}
					break;
				}
				case "line": {
					applyStroke(c, cmd, "#000000");
					let x1 = numOr(cmd.x1, 0);
					let y1 = numOr(cmd.y1, 0);
					let x2 = numOr(cmd.x2, 0);
					let y2 = numOr(cmd.y2, 0);
					// Axis-aligned hairlines: snap the center so both edges land on
					// device pixels (a 1 px line at y=10.5 turns into gray mush).
					const d = densityOf(c);
					if (Math.abs(y2 - y1) < 1e-6) {
						y1 = y2 = snapStroke(y1, d, c.lineWidth);
					} else if (Math.abs(x2 - x1) < 1e-6) {
						x1 = x2 = snapStroke(x1, d, c.lineWidth);
					}
					c.beginPath();
					c.moveTo(x1, y1);
					c.lineTo(x2, y2);
					c.stroke();
					break;
				}
				case "arrow": {
					const x1 = numOr(cmd.x1, 0);
					const y1 = numOr(cmd.y1, 0);
					const x2 = numOr(cmd.x2, 0);
					const y2 = numOr(cmd.y2, 0);
					applyStroke(c, cmd, "#000000");
					const color = c.strokeStyle;
					const lw = c.lineWidth;
					// Head length scales with the stroke so thin arrows stay readable.
					const head = Math.max(4, numOr(cmd.head, Math.min(24, 7 + lw * 2.5)));
					const angle = Math.atan2(y2 - y1, x2 - x1);
					const length = Math.hypot(x2 - x1, y2 - y1);
					// Stop the shaft just under the head: drawing it to the tip
					// makes the rounded/burred end double up with the filled head
					// (a darker blob at the tip whenever opacity < 1).
					const trim = length > head * 1.2 ? head * 0.9 : length * 0.5;
					const sx = x2 - Math.cos(angle) * trim;
					const sy = y2 - Math.sin(angle) * trim;
					c.beginPath();
					c.moveTo(x1, y1);
					c.lineTo(sx, sy);
					c.stroke();
					const spread = Math.PI / 7;
					c.beginPath();
					c.moveTo(x2, y2);
					c.lineTo(x2 - head * Math.cos(angle - spread), y2 - head * Math.sin(angle - spread));
					c.lineTo(x2 - head * Math.cos(angle + spread), y2 - head * Math.sin(angle + spread));
					c.closePath();
					c.fillStyle = color;
					c.fill();
					break;
				}
				case "path": {
					const pts = readPoints(cmd.points);
					if (pts.length < 2) break;
					const fill = typeof cmd.fill === "string" && cmd.fill !== "" ? cmd.fill : null;
					const closed = cmd.closed === true || fill !== null;
					c.beginPath();
					c.moveTo(pts[0][0], pts[0][1]);
					if (cmd.smooth === true && pts.length > 2) {
						// Catmull-Rom -> cubic Bézier: the curve passes THROUGH every
						// point (the old midpoint-quadratic version cut corners and
						// drifted off the data). Duplicate points are dropped first
						// so the tangents never collapse to NaN.
						const p = [pts[0]];
						for (let i = 1; i < pts.length; i++) {
							const last = p[p.length - 1];
							if (Math.abs(pts[i][0] - last[0]) > 1e-6 || Math.abs(pts[i][1] - last[1]) > 1e-6) p.push(pts[i]);
						}
						if (p.length < 3) {
							for (let i = 1; i < p.length; i++) c.lineTo(p[i][0], p[i][1]);
						} else {
							for (let i = 0; i < p.length - 1; i++) {
								const p0 = p[i - 1] || p[i];
								const p1 = p[i];
								const p2 = p[i + 1];
								const p3 = p[i + 2] || p2;
								c.bezierCurveTo(
									p1[0] + (p2[0] - p0[0]) / 6, p1[1] + (p2[1] - p0[1]) / 6,
									p2[0] - (p3[0] - p1[0]) / 6, p2[1] - (p3[1] - p1[1]) / 6,
									p2[0], p2[1]
								);
							}
						}
					} else {
						for (let i = 1; i < pts.length; i++) c.lineTo(pts[i][0], pts[i][1]);
					}
					if (closed) c.closePath();
					const bbox = bboxOfPoints(pts);
					if (fill !== null) {
						c.fillStyle = paint(c, fill, bbox);
						c.fill();
					}
					if (wantsStroke(cmd) || fill === null) {
						applyStroke(c, cmd, "#000000", bbox);
						c.stroke();
					}
					break;
				}
				case "arc": {
					const cx = numOr(cmd.cx, 0);
					const cy = numOr(cmd.cy, 0);
					const r = Math.max(0, numOr(cmd.r, 0));
					const start = numOr(cmd.start, 0) * (Math.PI / 180);
					const end = numOr(cmd.end, 360) * (Math.PI / 180);
					const pie = cmd.pie === true;
					const bbox = { x: cx - r, y: cy - r, w: r * 2, h: r * 2 };
					c.beginPath();
					if (pie) c.moveTo(cx, cy);
					c.arc(cx, cy, r, start, end, cmd.ccw === true);
					if (pie) c.closePath();
					const fill = typeof cmd.fill === "string" && cmd.fill !== "" ? cmd.fill : null;
					if (fill !== null) {
						c.fillStyle = paint(c, fill, bbox);
						c.fill();
					}
					if (wantsStroke(cmd) || fill === null) {
						applyStroke(c, cmd, "#000000", bbox);
						c.stroke();
					}
					break;
				}
				case "rect": {
					let x = numOr(cmd.x, 0);
					let y = numOr(cmd.y, 0);
					let w = numOr(cmd.w, 0);
					let h = numOr(cmd.h, 0);
					if (w < 0) { x += w; w = -w; }
					if (h < 0) { y += h; h = -h; }
					const r = cmd.radius === undefined ? 0 : Math.max(0, numOr(cmd.radius, 0));
					const fill = typeof cmd.fill === "string" && cmd.fill !== "" ? cmd.fill : null;
					const stroke = typeof cmd.stroke === "string" && cmd.stroke !== "" ? cmd.stroke : null;
					if (fill !== null) {
						c.fillStyle = paint(c, fill, { x, y, w, h });
						roundRectPath(c, x, y, w, h, r);
						c.fill();
					}
					if (stroke !== null) {
						applyStroke(c, cmd, "#000000", { x, y, w, h });
						// Square-cornered strokes snap to the device grid: 1 px
						// borders become one solid row/column instead of two gray
						// ones. Rounded corners are antialiased by design, so they
						// keep their exact geometry.
						let sx = x;
						let sy = y;
						let sw = w;
						let sh = h;
						if (r === 0) {
							const d = densityOf(c);
							const lw = c.lineWidth;
							sx = snapStroke(x, d, lw);
							sy = snapStroke(y, d, lw);
							sw = snapStroke(x + w, d, lw) - sx;
							sh = snapStroke(y + h, d, lw) - sy;
						}
						roundRectPath(c, sx, sy, sw, sh, r);
						c.stroke();
					}
					break;
				}
				case "circle":
					drawShape(c, numOr(cmd.cx, 0), numOr(cmd.cy, 0), numOr(cmd.r, 0), numOr(cmd.r, 0), cmd);
					break;
				case "ellipse":
					drawShape(c, numOr(cmd.cx, 0), numOr(cmd.cy, 0), numOr(cmd.rx, 0), numOr(cmd.ry, 0), cmd);
					break;
				case "table":
					drawTable(c, cmd);
					break;
				case "field":
					drawField(c, cmd);
					break;
				case "plot":
					drawPlot(c, cmd);
					break;
				case "grid":
					drawGrid(c, cmd);
					break;
				case "curve":
					drawCurve(c, cmd);
					break;
				case "stack":
					drawStack(c, cmd);
					break;
				case "clear": {
					c.fillStyle = strOr(cmd.color, "#ffffff");
					c.fillRect(0, 0, c.canvas.width, c.canvas.height);
					break;
				}
				default:
					break;
			}
			if (shadowed) clearShadow(c);
			c.globalAlpha = 1;
			c.globalCompositeOperation = "source-over";
			c.filter = "none";
			c.setLineDash([]);
		}

		// ---- data table ----

		/** Column widths: fixed widths first, the remaining space is shared. */
		function tableColumns(cmd) {
			const cols = Array.isArray(cmd.columns)
				? cmd.columns.filter((col) => col !== null && typeof col === "object")
				: [];
			const w = Math.max(0, numOr(cmd.w, 0));
			let fixed = 0;
			let flexible = 0;
			for (const col of cols) {
				if (Number.isFinite(Number(col.width))) fixed += Math.max(0, Number(col.width));
				else flexible += 1;
			}
			const rest = Math.max(0, w - fixed);
			return cols.map((col) => ({
				title: String(col.title ?? ""),
				align: strOr(col.align, "left"),
				width: Number.isFinite(Number(col.width))
					? Math.max(0, Number(col.width))
					: (flexible > 0 ? rest / flexible : 0),
			}));
		}

		function tableHeight(cmd) {
			const cols = Array.isArray(cmd.columns) ? cmd.columns : [];
			const rows = Array.isArray(cmd.rows) ? cmd.rows : [];
			const rowH = Math.max(0, numOr(cmd.rowHeight, 30));
			const headH = cols.length > 0 ? Math.max(0, numOr(cmd.headerHeight, rowH)) : 0;
			return headH + rows.length * rowH;
		}

		function drawTable(c, cmd) {
			const cols = tableColumns(cmd);
			if (cols.length === 0) return;
			const rows = Array.isArray(cmd.rows) ? cmd.rows : [];
			const x = numOr(cmd.x, 0);
			const y = numOr(cmd.y, 0);
			const w = Math.max(0, numOr(cmd.w, 0));
			const rowH = Math.max(1, numOr(cmd.rowHeight, 30));
			const headH = Math.max(0, numOr(cmd.headerHeight, rowH));
			const size = Math.max(1, numOr(cmd.size, 12));
			const padX = Math.max(0, numOr(cmd.padding, 12));
			const border = strOr(cmd.stroke, "#e6eaf0");
			const headFill = strOr(cmd.fill, "#f7f9fc");
			const headColor = strOr(cmd.headerColor, "#64748b");
			const bodyColor = strOr(cmd.color, "#0f172a");
			const zebra = cmd.zebra !== false;
			const totalH = headH + rows.length * rowH;
			const d = densityOf(c);
			if (headH > 0) {
				c.fillStyle = paint(c, headFill, { x, y, w, h: headH });
				c.fillRect(x, y, w, headH);
			}
			if (zebra) {
				c.fillStyle = "rgba(15,23,42,0.022)";
				for (let i = 0; i < rows.length; i++) {
					if (i % 2 === 1) c.fillRect(x, y + headH + i * rowH, w, rowH);
				}
			}
			// horizontal rules, snapped so 1 px lines stay solid
			applyStroke(c, { color: border, width: 1 }, border);
			c.beginPath();
			const rule = (ly) => {
				const sy = snapStroke(ly, d, 1);
				c.moveTo(x, sy);
				c.lineTo(x + w, sy);
			};
			rule(y + 1);
			if (headH > 0) rule(y + headH);
			for (let i = 1; i <= rows.length; i++) rule(y + headH + i * rowH);
			c.stroke();
			// column separators
			c.beginPath();
			let sepX = x;
			for (let i = 0; i < cols.length - 1; i++) {
				sepX += cols[i].width;
				const sx = snapStroke(sepX, d, 1);
				c.moveTo(sx, y + 1);
				c.lineTo(sx, y + totalH);
			}
			c.stroke();
			const cell = (text, left, widthPx, cy, align, color, weight) => {
				c.font = `${weight || "normal"} ${size}px ${strOr(cmd.font, "sans-serif")}`;
				c.fillStyle = color;
				c.textAlign = align;
				const tx = align === "right" ? left + widthPx - padX : align === "center" ? left + widthPx / 2 : left + padX;
				c.fillText(String(text ?? ""), tx, cy, Math.max(1, widthPx - padX * 2));
			};
			c.textBaseline = "middle";
			let headX = x;
			for (const col of cols) {
				if (headH > 0) cell(col.title, headX, col.width, y + headH / 2 + 0.5, col.align, headColor, "bold");
				headX += col.width;
			}
			for (let r = 0; r < rows.length; r++) {
				const row = Array.isArray(rows[r]) ? rows[r] : [];
				const cy = y + headH + r * rowH + rowH / 2 + 0.5;
				let cx = x;
				for (let j = 0; j < cols.length; j++) {
					cell(row[j], cx, cols[j].width, cy, cols[j].align, bodyColor, "normal");
					cx += cols[j].width;
				}
			}
			c.textBaseline = "alphabetic";
		}

		// ---- stack: vertical auto layout ----

		/** Height a stack child will occupy (text is wrapped at the inner width). */
		function childHeight(c, kid, innerW) {
			if (kid === null || typeof kid !== "object" || typeof kid.op !== "string") return 0;
			switch (kid.op) {
				case "text": {
					const offset = Math.max(0, numOr(kid.x, 0));
					const layout = textLayout(c, kid, Math.max(0, innerW - offset));
					return layout.lines.length * layout.step;
				}
				case "rect": return Math.max(0, numOr(kid.h, 0));
				case "circle": return Math.max(0, 2 * numOr(kid.r, 0));
				case "ellipse": return Math.max(0, 2 * numOr(kid.ry, 0));
				case "table": return tableHeight(kid);
				default: return 0;
			}
		}

		function drawStack(c, cmd) {
			const x = numOr(cmd.x, 0);
			const y = numOr(cmd.y, 0);
			const w = Math.max(0, numOr(cmd.w, 0));
			const pad = Math.max(0, numOr(cmd.padding, 14));
			const gap = Math.max(0, numOr(cmd.gap, 10));
			const kids = Array.isArray(cmd.children)
				? cmd.children.filter((kid) => kid !== null && typeof kid === "object" && typeof kid.op === "string")
				: [];
			const innerW = Math.max(0, w - pad * 2);
			const heights = kids.map((kid) => childHeight(c, kid, innerW));
			let total = pad * 2;
			for (let i = 0; i < heights.length; i++) {
				total += heights[i];
				if (i < heights.length - 1) total += gap;
			}
			const fill = typeof cmd.fill === "string" && cmd.fill !== "" ? cmd.fill : null;
			const stroke = typeof cmd.stroke === "string" && cmd.stroke !== "" ? cmd.stroke : null;
			const radius = cmd.radius === undefined ? 12 : Math.max(0, numOr(cmd.radius, 0));
			if (fill !== null) {
				roundRectPath(c, x, y, w, total, radius);
				c.fillStyle = paint(c, fill, { x, y, w, h: total });
				c.fill();
			}
			if (stroke !== null) {
				roundRectPath(c, x, y, w, total, radius);
				applyStroke(c, cmd, "#000000", { x, y, w, h: total });
				c.stroke();
			}
			const baseAlpha = c.globalAlpha;
			let cursor = y + pad;
			for (let i = 0; i < kids.length; i++) {
				const kid = kids[i];
				const child = Object.assign({}, kid);
				if (baseAlpha < 1) child.opacity = numOr(kid.opacity, 1) * baseAlpha;
				const offset = Math.max(0, numOr(kid.x, 0));
				switch (child.op) {
					case "text":
						if (child.maxWidth === undefined) child.maxWidth = Math.max(0, innerW - offset);
						child.x = x + pad + offset;
						child.y = cursor;
						break;
					case "rect":
						child.x = x + pad + offset;
						child.y = cursor;
						break;
					case "table":
						if (child.w === undefined) child.w = Math.max(0, innerW - offset);
						child.x = x + pad + offset;
						child.y = cursor;
						break;
					case "circle":
					case "ellipse":
						child.cx = x + pad + offset;
						child.cy = cursor + heights[i] / 2;
						break;
					case "arc":
						child.cx = x + pad + offset;
						child.cy = cursor + heights[i] / 2;
						break;
					case "line":
					case "arrow":
						child.x1 = x + pad + offset;
						child.y1 = cursor + numOr(kid.y1, 0);
						child.x2 = x + pad + numOr(kid.x2, 0);
						child.y2 = cursor + numOr(kid.y2, 0);
						break;
					default:
						break;
				}
				try {
					drawCommand(c, child);
				} catch (e) {
					// one bad child must not kill the block
				}
				cursor += heights[i] + gap;
			}
			c.globalAlpha = baseAlpha;
		}

		/** Backing-store density: the canvas is drawn at `scale`× the logical
		 *  size so the PNG stays sharp after the GUI shrinks it to fit the chat
		 *  column (and on hi-DPI screens). Logical coordinates are unaffected.
		 *  Defaults to 2; a side never exceeds 4096 px. */
		function pixelScale(args, width, height) {
			const asked = numOr(args.scale, 2);
			let scale = Math.max(1, Math.min(3, asked));
			const room = 4096 / Math.max(width, height);
			if (scale > room) scale = Math.max(1, room);
			return scale;
		}

		/** Paint the full command list onto the canvas, then scale the backing
		 *  store so command coordinates map 1:1 to logical (CSS) pixels while
		 *  the PNG itself carries `pixelScale` times the detail. */
		async function draw(canvas, args) {
			const width = clampInt(args.width, 64, 2048, 800);
			const height = clampInt(args.height, 64, 2048, 500);
			const density = pixelScale(args, width, height);
			const commands = Array.isArray(args.commands) ? args.commands : [];
			await ensureFonts(commands);
			measureCache.clear();
			canvas.width = Math.round(width * density);
			canvas.height = Math.round(height * density);
			// Inline width only: `.dshEyes_canvas{height:auto}` then preserves the
			// aspect ratio while `max-width:100%` fits the chat column. Setting an
			// inline height too would override height:auto and squash the picture.
			canvas.style.width = width + "px";
			canvas.style.height = "";
			const c = canvas.getContext("2d");
			c.setTransform(density, 0, 0, density, 0, 0);
			c.fillStyle = strOr(args.background, "#ffffff");
			c.fillRect(0, 0, width, height);
			for (const cmd of commands) {
				// Isolate every command: even if one throws mid-way, its filter /
				// blend / transform / alpha can not bleed into the next command.
				c.save();
				try {
					drawCommand(c, cmd);
				} catch (e) {
					// skip a bad command, keep the rest
				} finally {
					c.restore();
				}
			}
			applyGrain(canvas, args.grain);
			return { width: canvas.width, height: canvas.height };
		}

		function base64FromBytes(bytes) {
			let binary = "";
			const chunk = 0x8000;
			for (let i = 0; i < bytes.length; i += chunk) {
				binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
			}
			return btoa(binary);
		}

		/** Page-lifetime dedupe: one upload attempt per tool call id. */
		const uploadedCalls = new Set();

		function uploadRender(callId, canvas, args, onStatus) {
			if (uploadedCalls.has(callId)) return;
			// Report the real PNG size (logical size × density), not the logical
			// canvas, so the host/README never claim a dimension the file lacks.
			const width = canvas.width;
			const height = canvas.height;
			onStatus("uploading");
			canvas.toBlob((blob) => {
				if (blob === null) {
					onStatus("upload-failed");
					return;
				}
				blob.arrayBuffer().then((buf) => {
					const pngBase64 = base64FromBytes(new Uint8Array(buf));
					return fetch("/eyes/render", {
						method: "POST",
						headers: { "content-type": "application/json" },
						body: JSON.stringify({ callId, width, height, pngBase64 })
					});
				}).then((res) => {
					if (res.ok) {
						uploadedCalls.add(callId);
						onStatus("uploaded");
					} else {
						onStatus("upload-failed");
					}
				}).catch(() => {
					onStatus("upload-failed");
				});
			}, "image/png");
		}

		/** Report a client-side failure (e.g. mermaid load/render) to the host so
		 *  the tool call fails with a clear message instead of timing out. */
		function uploadError(callId, message) {
			if (uploadedCalls.has(callId)) return;
			fetch("/eyes/render", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ callId, error: String(message) })
			}).catch(() => {});
		}

		// ---- mermaid: render a diagram source onto the canvas ----
		const MERMAID_CDN = "https://cdn.jsdelivr.net/npm/mermaid@11.16.1/dist/mermaid.min.js";
		let mermaidPromise = null;

		/** Load mermaid (host-served local copy first, then CDN fallback), once. */
		function loadMermaid() {
			if (mermaidPromise) return mermaidPromise;
			mermaidPromise = new Promise((resolve, reject) => {
				if (typeof window === "undefined") { reject(new Error("no window")); return; }
				if (window.mermaid && typeof window.mermaid.render === "function") { resolve(window.mermaid); return; }
				const ready = () => {
					if (window.mermaid && typeof window.mermaid.render === "function") {
						try { window.mermaid.initialize({ startOnLoad: false, securityLevel: "strict", theme: "default" }); } catch (e) { /* ignore */ }
						resolve(window.mermaid);
					} else {
						reject(new Error("mermaid loaded but not available"));
					}
				};
				const local = document.getElementById("dsh-omni-vision-mermaid");
				if (local !== null) {
					// already loading; wait for its load event to have run
					if (window.mermaid) ready();
					else local.addEventListener("load", ready);
					return;
				}
				const s = document.createElement("script");
				s.id = "dsh-omni-vision-mermaid";
				s.src = "/eyes/mermaid.min.js"; // served by the host when a local copy is installed
				s.onload = ready;
				s.onerror = () => {
					// local copy absent: fall back to CDN (needs browser network)
					const s2 = document.createElement("script");
					s2.id = "dsh-omni-vision-mermaid-cdn";
					s2.src = MERMAID_CDN;
					s2.onload = ready;
					s2.onerror = () => reject(new Error("failed to load mermaid (no network?)"));
					document.head.appendChild(s2);
				};
				document.head.appendChild(s);
			});
			return mermaidPromise;
		}

		/** Strip optional ```mermaid fences from the diagram source. */
		function normalizeMermaid(source) {
			const s = String(source ?? "").trim();
			if (s.startsWith("```")) {
				return s.replace(/^```(?:mermaid)?\s*/i, "").replace(/```\s*$/, "").trim();
			}
			return s;
		}

		/** Intrinsic size of a mermaid SVG (viewBox first, then width/height attrs). */
		function svgViewBox(svgText) {
			const vb = svgText.match(/viewBox\s*=\s*["']([\d.\-]+)[\s,]+([\d.\-]+)[\s,]+([\d.\-]+)[\s,]+([\d.\-]+)["']/);
			if (vb !== null) {
				return { w: parseFloat(vb[3]), h: parseFloat(vb[4]) };
			}
			const w = svgText.match(/width\s*=\s*["']([\d.]+)\s*px?["']/);
			const h = svgText.match(/height\s*=\s*["']([\d.]+)\s*px?["']/);
			if (w !== null && h !== null) return { w: parseFloat(w[1]), h: parseFloat(h[1]) };
			return null;
		}

		/** Rewrite the SVG root's intrinsic size to the target DEVICE pixel size.
		 *  Without this the browser rasterizes the SVG at its small intrinsic
		 *  size and drawImage() upscales that bitmap, so diagram text comes out
		 *  soft exactly when the canvas is scaled up for detail. */
		function sizeSvg(svgText, cssW, cssH, density) {
			if (!/viewBox\s*=/.test(svgText)) return svgText; // sizing alone would crop
			const pw = Math.max(1, Math.round(cssW * density));
			const ph = Math.max(1, Math.round(cssH * density));
			return svgText.replace(/<svg\b[^>]*>/i, (tag) => {
				let t = tag.replace(/max-width:\s*[\d.]+(?:px|em|rem)?;?/gi, "");
				t = /\swidth\s*=/i.test(t)
					? t.replace(/\swidth\s*=\s*("[^"]*"|'[^']*')/i, ` width="${pw}"`)
					: t.replace(/^<svg/i, `<svg width="${pw}"`);
				t = /\sheight\s*=/i.test(t)
					? t.replace(/\sheight\s*=\s*("[^"]*"|'[^']*')/i, ` height="${ph}"`)
					: t.replace(/^<svg/i, `<svg height="${ph}"`);
				return t;
			});
		}

		/** Render a mermaid source onto the canvas, contain-fitted with padding.
		 *  When the caller did not pin `height`, the canvas is sized to the
		 *  diagram's own aspect ratio instead of leaving big white bands. */
		async function renderMermaid(canvas, source, args, width) {
			const mm = await loadMermaid();
			const id = "eyes-mm-" + Math.random().toString(36).slice(2) + "-" + Date.now();
			let result;
			try {
				result = await mm.render(id, normalizeMermaid(source));
			} finally {
				const temp = document.getElementById("d" + id);
				if (temp) temp.remove();
			}
			const svgText = result && typeof result.svg === "string" ? result.svg : null;
			if (svgText === null) throw new Error("mermaid produced no SVG");
			const vb = svgViewBox(svgText);
			if (vb === null || vb.w <= 0 || vb.h <= 0) throw new Error("mermaid SVG has no usable viewBox");
			const pad = 16;
			let height = clampInt(args.height, 64, 2048, 500);
			if (args.height === undefined) {
				height = clampInt(Math.round(vb.h * ((width - pad * 2) / vb.w) + pad * 2), 64, 2048, 500);
			}
			const d = pixelScale(args, width, height);
			canvas.width = Math.round(width * d);
			canvas.height = Math.round(height * d);
			canvas.style.width = width + "px";
			canvas.style.height = "";
			const c = canvas.getContext("2d");
			c.setTransform(d, 0, 0, d, 0, 0);
			c.imageSmoothingEnabled = true;
			c.imageSmoothingQuality = "high";
			c.fillStyle = strOr(args.background, "#ffffff");
			c.fillRect(0, 0, width, height);
			const scale = Math.min((width - pad * 2) / vb.w, (height - pad * 2) / vb.h);
			const dw = vb.w * scale;
			const dh = vb.h * scale;
			const dx = (width - dw) / 2;
			const dy = (height - dh) / 2;
			const sized = sizeSvg(svgText, dw, dh, d);
			const img = new Image();
			await new Promise((resolve, reject) => {
				img.onload = resolve;
				img.onerror = () => reject(new Error("could not rasterize the mermaid SVG"));
				img.src = "data:image/svg+xml;charset=utf-8," + encodeURIComponent(sized);
			});
			c.drawImage(img, dx, dy, dw, dh);
		}

		// ---- card component ----
		function EyesCard(props) {
			const { callId, toolName, block } = props;
			const settled = block !== undefined && "kind" in block;
			const argsRaw = settled ? block.call?.argsRaw : block?.argsRaw;
			const args = parseArgs(argsRaw);
			const canvasRef = React.useRef(null);
			const [status, setStatus] = React.useState("drawing");
			const [errorMsg, setErrorMsg] = React.useState("");

			React.useEffect(() => {
				const canvas = canvasRef.current;
				if (canvas === null || args === null) {
					setStatus("error");
					return;
				}
				let cancelled = false;
				(async () => {
					try {
						const mermaidSrc = typeof args.mermaid === "string" && args.mermaid.trim() !== ""
							? args.mermaid
							: null;
						if (mermaidSrc !== null) {
							// Mermaid takes precedence over drawing commands.
							setStatus("loading-mermaid");
							const width = clampInt(args.width, 64, 2048, 800);
							await renderMermaid(canvas, mermaidSrc, args, width);
							if (cancelled) return;
							if (settled) { setStatus(block.isError ? "error" : "ok"); return; }
							uploadRender(callId, canvas, args, setStatus);
						} else {
							await draw(canvas, args);
							if (cancelled) return;
							if (settled) { setStatus(block.isError ? "error" : "ok"); return; }
							uploadRender(callId, canvas, args, setStatus);
						}
					} catch (e) {
						if (cancelled) return;
						const msg = e instanceof Error ? e.message : String(e);
						setErrorMsg("Mermaid: " + msg);
						setStatus("mermaid-error");
						if (!settled) uploadError(callId, msg);
					}
				})();
				return () => { cancelled = true; };
			}, [callId, settled, argsRaw]);

			const title = args !== null && typeof args.title === "string" && args.title !== "" ? args.title : "Eyes canvas";
			const statusText = {
				drawing: "drawing…",
				"loading-mermaid": "loading mermaid…",
				uploading: "rendering…",
				uploaded: "rendered ✓",
				"upload-failed": "render upload failed",
				"mermaid-error": "mermaid failed",
				ok: "rendered",
				error: settled && block.isError ? "render failed" : "invalid commands"
			}[status] ?? status;
			const frame = React.createElement("div", { className: "dshEyes_frame" },
				React.createElement("canvas", { ref: canvasRef, className: "dshEyes_canvas", "data-tool": toolName })
			);
			const header = React.createElement("div", { className: "dshEyes_header" },
				React.createElement("span", { className: "dshEyes_title" }, title),
				React.createElement("span", { className: "dshEyes_status", "data-state": status === "error" || status === "upload-failed" || status === "mermaid-error" ? "error" : status === "ok" || status === "uploaded" ? "ok" : undefined }, statusText)
			);
			const note = status === "upload-failed"
				? React.createElement("div", { className: "dshEyes_note", "data-error": true }, "The canvas drew but the PNG could not be delivered to the host; reload the page and retry if needed.")
				: status === "mermaid-error"
					? React.createElement("div", { className: "dshEyes_note", "data-error": true }, errorMsg)
					: settled
						? React.createElement("div", { className: "dshEyes_note" }, "Replayed from history")
						: null;
			return React.createElement("div", { className: "dshEyes_card", "data-tool": "eyes_render", "data-state": settled ? (block.isError ? "error" : "ok") : "running" },
				header, frame, note);
		}

		/** Page-lifetime dedupe: one capture attempt per tool call id. */
		const pastedCalls = new Set();

		function firstImageFile(list) {
			if (!list) return null;
			for (let i = 0; i < list.length; i++) {
				const f = list[i];
				if (f && typeof f.type === "string" && f.type.indexOf("image/") === 0) return f;
			}
			return null;
		}

		/** True while a file drag is in progress: dataTransfer.types exposes
		 *  "Files" reliably during dragenter/dragover (unlike .files). */
		function draggingFiles(dataTransfer) {
			const types = dataTransfer && dataTransfer.types;
			if (types) {
				for (let i = 0; i < types.length; i++) {
					if (types[i] === "Files") return true;
				}
			}
			return false;
		}

		/** Normalize one image File to PNG and POST it to /eyes/paste. */
		function captureImageFile(callId, file, setStatus) {
			if (pastedCalls.has(callId)) return;
			pastedCalls.add(callId);
			setStatus("processing");
			const url = URL.createObjectURL(file);
			const img = new Image();
			img.onload = () => {
				try {
					const canvas = document.createElement("canvas");
					canvas.width = img.naturalWidth || 1;
					canvas.height = img.naturalHeight || 1;
					const c = canvas.getContext("2d");
					c.drawImage(img, 0, 0);
					canvas.toBlob((blob) => {
						URL.revokeObjectURL(url);
						if (blob === null) {
							setStatus("error");
							return;
						}
						blob.arrayBuffer().then((buf) => {
							const pngBase64 = base64FromBytes(new Uint8Array(buf));
							return fetch("/eyes/paste", {
								method: "POST",
								headers: { "content-type": "application/json" },
								body: JSON.stringify({ callId, width: canvas.width, height: canvas.height, pngBase64 })
							});
						}).then((res) => {
							setStatus(res.ok ? "ok" : "upload-failed");
						}).catch(() => {
							setStatus("upload-failed");
						});
					}, "image/png");
				} catch (e) {
					URL.revokeObjectURL(url);
					setStatus("error");
				}
			};
			img.onerror = () => {
				URL.revokeObjectURL(url);
				setStatus("error");
			};
			img.src = url;
		}

		// ---- capture card: clipboard paste OR image drop, while the call runs ----
		function PasteCard(props) {
			const { callId, block } = props;
			const settled = block !== undefined && "kind" in block;
			const [status, setStatus] = React.useState(settled ? "ok" : "waiting");

			React.useEffect(() => {
				if (settled) {
					setStatus(block.isError ? "error" : "ok");
					return;
				}
				setStatus("waiting");
				const onPaste = (event) => {
					if (pastedCalls.has(callId)) return;
					const items = event.clipboardData && event.clipboardData.items;
					if (!items) return;
					let file = null;
					for (let i = 0; i < items.length; i++) {
						const item = items[i];
						if (item && item.kind === "file" && typeof item.type === "string" && item.type.indexOf("image/") === 0) {
							file = item.getAsFile ? item.getAsFile() : null;
							if (file) break;
						}
					}
					if (file === null) {
						// A paste happened but the clipboard holds no image (e.g. text).
						setStatus("no-image");
						return; // leave the paste to the composer
					}
					event.preventDefault();
					event.stopPropagation();
					captureImageFile(callId, file, setStatus);
				};
				// While this card is active, swallow ALL drag events at window
				// capture so the native composer never sees them: its drop overlay
				// (dragActive) would otherwise appear and then never reset, because
				// our drop handler stops propagation and its reset() never runs —
				// leaving the overlay stuck on screen until a refresh.
				// Note: during dragenter/dragover the browser does NOT expose
				// dataTransfer.files (only types), so detect file drags via
				// types.includes("Files") — exactly like the native composer does.
				const onDragEnter = (event) => {
					if (pastedCalls.has(callId)) return;
					if (!draggingFiles(event.dataTransfer)) return;
					if (event.dataTransfer) event.dataTransfer.dropEffect = "copy";
					event.preventDefault();
					event.stopPropagation();
					setStatus("drop-hover");
				};
				const onDragOver = (event) => {
					if (pastedCalls.has(callId)) return;
					if (!draggingFiles(event.dataTransfer)) return;
					if (event.dataTransfer) event.dataTransfer.dropEffect = "copy";
					event.preventDefault();
					event.stopPropagation();
					setStatus("drop-hover");
				};
				const onDragLeave = (event) => {
					if (pastedCalls.has(callId)) return;
					if (!draggingFiles(event.dataTransfer)) return;
					event.preventDefault();
					event.stopPropagation();
					setStatus("waiting");
				};
				const onDrop = (event) => {
					if (pastedCalls.has(callId)) return;
					if (!draggingFiles(event.dataTransfer)) return;
					event.preventDefault();
					event.stopPropagation();
					// Grab the File synchronously (dataTransfer.files is only valid
					// during the event), then defer the work: mutating the DOM
					// (React state) synchronously inside `drop` can leave the
					// browser's drag ghost stuck on screen until a refresh.
					const file = firstImageFile(event.dataTransfer.files);
					if (file !== null) setTimeout(() => captureImageFile(callId, file, setStatus), 0);
					else setStatus("not-image");
				};
				window.addEventListener("paste", onPaste, true);
				window.addEventListener("dragenter", onDragEnter, true);
				window.addEventListener("dragover", onDragOver, true);
				window.addEventListener("dragleave", onDragLeave, true);
				window.addEventListener("drop", onDrop, true);
				return () => {
					window.removeEventListener("paste", onPaste, true);
					window.removeEventListener("dragenter", onDragEnter, true);
					window.removeEventListener("dragover", onDragOver, true);
					window.removeEventListener("dragleave", onDragLeave, true);
					window.removeEventListener("drop", onDrop, true);
				};
			}, [callId, settled]);

			const statusText = {
				waiting: "等待图片…",
				"drop-hover": "松开鼠标接收图片",
				"no-image": "剪贴板无图片",
				"not-image": "仅支持图片",
				processing: "接收中…",
				ok: "已接收 ✓",
				"upload-failed": "上传失败",
				error: "图片无效"
			}[status] ?? status;
			const header = React.createElement("div", { className: "dshEyes_header" },
				React.createElement("span", { className: "dshEyes_title" }, "收图"),
				React.createElement("span", { className: "dshEyes_status", "data-state": status === "error" || status === "upload-failed" ? "error" : status === "ok" ? "ok" : undefined }, statusText)
			);
			const boxBody =
				status === "waiting"
					? React.createElement(React.Fragment, null,
							"把图片文件直接拖到这里松开，或复制图片后按 ",
							React.createElement("kbd", { className: "dshEyes_kbd" }, "Ctrl+V"),
							"：图片会存入工作区，我随后就能读取。")
					: status === "drop-hover"
						? "松开鼠标：图片将存入工作区"
						: status === "no-image"
							? "检测到粘贴，但剪贴板里没有图片 —— 请先复制一张图片（截图/照片）再按 Ctrl+V"
							: status === "not-image"
								? "只能接收图片文件（PNG/JPG/WebP/GIF），请重新拖入图片"
								: status === "ok"
								? "图片已接收并保存到工作区，我马上读取它。"
								: statusText;
			const box = React.createElement("div", { className: "dshEyes_pastebox", "data-state": status === "ok" ? "ok" : status === "error" || status === "upload-failed" ? "error" : status === "waiting" || status === "drop-hover" ? "live" : undefined }, boxBody);
			return React.createElement("div", { className: "dshEyes_card", "data-tool": "eyes_paste", "data-state": settled ? (block.isError ? "error" : "ok") : "running" },
				header, box);
		}

		function apply(ctx) {
			ctx.slots.inject("tool.call.toolview", () => ctx.slots.register({
				name: "tool.call.toolview",
				key: "eyes_render",
				inject: () => ({})
			}, EyesCard));
			ctx.slots.inject("tool.call.toolview", () => ctx.slots.register({
				name: "tool.call.toolview",
				key: "eyes_paste",
				inject: () => ({})
			}, PasteCard));
		}

		exports.name = "dsh-omni-vision";
		exports.inject = ["slots"];
		exports.apply = apply;
		return module.exports;
	}
});
