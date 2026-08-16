/**
 * dsh-eyes client half — hand-written module-loader factory bundle (no build
 * step). The loader table provides `react`; everything else is plain DOM.
 *
 * Registers a keyed `tool.call.toolview` entry for `eyes_render`: renders the
 * drawing commands on a <canvas> inside the conversation card, and while the
 * call is still running, serializes the canvas to PNG and POSTs it back to
 * `POST /eyes/render` (matched by the tool-call id) so the host tool can
 * resolve. Settled blocks (history replay) redraw without uploading.
 */
window.__ModuleLoader__.load({
	id: "dsh-eyes",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		const React = require("react");

		// ---- styles (injected once at materialization, like the built bundles) ----
		const CSS_TAG = "dsh-eyes/card.css";
		if (typeof document !== "undefined" && document.querySelector("style[data-plugin-css=" + JSON.stringify(CSS_TAG) + "]") === null) {
			const tag = document.createElement("style");
			tag.dataset.plugin = "dsh-eyes";
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

		function roundRectPath(c, x, y, w, h, r) {
			const rr = Math.max(0, Math.min(r, Math.abs(w) / 2, Math.abs(h) / 2));
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

		function drawShape(c, cx, cy, rx, ry, cmd) {
			const fill = typeof cmd.fill === "string" && cmd.fill !== "" ? cmd.fill : null;
			const stroke = typeof cmd.stroke === "string" && cmd.stroke !== "" ? cmd.stroke : null;
			c.beginPath();
			c.ellipse(cx, cy, Math.max(0, rx), Math.max(0, ry), 0, 0, Math.PI * 2);
			if (fill !== null) {
				c.fillStyle = fill;
				c.fill();
			}
			if (stroke !== null) {
				c.strokeStyle = stroke;
				c.lineWidth = numOr(cmd.strokeWidth, 2);
				c.stroke();
			}
		}

		/** Draw one command; bad commands are skipped, never fatal. */
		function drawCommand(c, cmd) {
			if (cmd === null || typeof cmd !== "object" || typeof cmd.op !== "string") return;
			switch (cmd.op) {
				case "text": {
					const text = String(cmd.text ?? "");
					if (text === "") return;
					const size = numOr(cmd.size, 16);
					const weight = strOr(cmd.weight, "normal");
					const font = strOr(cmd.font, "sans-serif");
					c.font = `${weight} ${size}px ${font}`;
					c.fillStyle = strOr(cmd.color, "#000000");
					c.textAlign = strOr(cmd.align, "left");
					const x = numOr(cmd.x, 0);
					const y = numOr(cmd.y, 0);
					const maxWidth = cmd.maxWidth === undefined ? undefined : Math.max(0, numOr(cmd.maxWidth, 0));
					const lines = text.split("\n");
					// Anchor the VISUAL top of the first line on y. textBaseline
					// "top" is engine-inconsistent: some engines align the font's
					// em-box top, which sits above the glyphs and pushes text below
					// the requested y. Instead draw on the alphabetic baseline at
					// y + actualBoundingBoxAscent, so the glyph top lands exactly
					// on y everywhere (metrics measured from the same baseline).
					let glyphAscent = null;
					try {
						const probe = lines.length > 0 && lines[0] !== "" ? lines[0] : "Ag";
						const m = c.measureText(probe);
						if (Number.isFinite(m.actualBoundingBoxAscent)) glyphAscent = m.actualBoundingBoxAscent;
					} catch {
						// metrics unavailable: fall through to plain "top" anchoring
					}
					if (glyphAscent !== null) {
						c.textBaseline = "alphabetic";
						for (let i = 0; i < lines.length; i++) {
							const line = lines[i];
							const baselineY = y + glyphAscent + i * size * 1.25;
							if (maxWidth === undefined) c.fillText(line, x, baselineY);
							else c.fillText(line, x, baselineY, maxWidth);
						}
					} else {
						c.textBaseline = "top";
						for (let i = 0; i < lines.length; i++) {
							const line = lines[i];
							const lineY = y + i * size * 1.25;
							if (maxWidth === undefined) c.fillText(line, x, lineY);
							else c.fillText(line, x, lineY, maxWidth);
						}
					}
					break;
				}
				case "line": {
					c.strokeStyle = strOr(cmd.color, strOr(cmd.stroke, "#000000"));
					c.lineWidth = numOr(cmd.width, numOr(cmd.strokeWidth, 2));
					c.beginPath();
					c.moveTo(numOr(cmd.x1, 0), numOr(cmd.y1, 0));
					c.lineTo(numOr(cmd.x2, 0), numOr(cmd.y2, 0));
					c.stroke();
					break;
				}
				case "rect": {
					const x = numOr(cmd.x, 0);
					const y = numOr(cmd.y, 0);
					const w = numOr(cmd.w, 0);
					const h = numOr(cmd.h, 0);
					const r = cmd.radius === undefined ? 0 : Math.max(0, numOr(cmd.radius, 0));
					const fill = typeof cmd.fill === "string" && cmd.fill !== "" ? cmd.fill : null;
					const stroke = typeof cmd.stroke === "string" && cmd.stroke !== "" ? cmd.stroke : null;
					if (fill !== null) {
						c.fillStyle = fill;
						roundRectPath(c, x, y, w, h, r);
						c.fill();
					}
					if (stroke !== null) {
						c.strokeStyle = stroke;
						c.lineWidth = numOr(cmd.strokeWidth, 2);
						roundRectPath(c, x, y, w, h, r);
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
				case "clear": {
					c.fillStyle = strOr(cmd.color, "#ffffff");
					c.fillRect(0, 0, c.canvas.width, c.canvas.height);
					break;
				}
				default:
					break;
			}
		}

		/** Paint the full command list onto the canvas at exactly the requested
		 *  pixel size — no devicePixelRatio scaling — so the saved PNG matches
		 *  width/height 1:1 and command coordinates map 1:1 to PNG pixels. */
		function draw(canvas, args) {
			const width = clampInt(args.width, 64, 2048, 800);
			const height = clampInt(args.height, 64, 2048, 500);
			canvas.width = width;
			canvas.height = height;
			canvas.style.width = width + "px";
			canvas.style.height = height + "px";
			const c = canvas.getContext("2d");
			c.setTransform(1, 0, 0, 1, 0, 0);
			c.fillStyle = strOr(args.background, "#ffffff");
			c.fillRect(0, 0, width, height);
			const commands = Array.isArray(args.commands) ? args.commands : [];
			for (const cmd of commands) {
				try {
					drawCommand(c, cmd);
				} catch (e) {
					// skip a bad command, keep the rest
				}
			}
			return { width, height };
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
			const width = clampInt(args.width, 64, 2048, 800);
			const height = clampInt(args.height, 64, 2048, 500);
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
				const local = document.getElementById("dsh-eyes-mermaid");
				if (local !== null) {
					// already loading; wait for its load event to have run
					if (window.mermaid) ready();
					else local.addEventListener("load", ready);
					return;
				}
				const s = document.createElement("script");
				s.id = "dsh-eyes-mermaid";
				s.src = "/eyes/mermaid.min.js"; // served by the host when a local copy is installed
				s.onload = ready;
				s.onerror = () => {
					// local copy absent: fall back to CDN (needs browser network)
					const s2 = document.createElement("script");
					s2.id = "dsh-eyes-mermaid-cdn";
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

		/** Render a mermaid source onto the canvas, contain-fitted with padding. */
		async function renderMermaid(canvas, source, background, width, height) {
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
			canvas.width = width;
			canvas.height = height;
			canvas.style.width = width + "px";
			canvas.style.height = height + "px";
			const c = canvas.getContext("2d");
			c.setTransform(1, 0, 0, 1, 0, 0);
			c.fillStyle = strOr(background, "#ffffff");
			c.fillRect(0, 0, width, height);
			const pad = 16;
			const scale = Math.min((width - pad * 2) / vb.w, (height - pad * 2) / vb.h);
			const dw = vb.w * scale;
			const dh = vb.h * scale;
			const dx = (width - dw) / 2;
			const dy = (height - dh) / 2;
			const img = new Image();
			await new Promise((resolve, reject) => {
				img.onload = resolve;
				img.onerror = () => reject(new Error("could not rasterize the mermaid SVG"));
				img.src = "data:image/svg+xml;charset=utf-8," + encodeURIComponent(svgText);
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
							const height = clampInt(args.height, 64, 2048, 500);
							await renderMermaid(canvas, mermaidSrc, args.background, width, height);
							if (cancelled) return;
							if (settled) { setStatus(block.isError ? "error" : "ok"); return; }
							uploadRender(callId, canvas, args, setStatus);
						} else {
							draw(canvas, args);
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

		exports.name = "dsh-eyes";
		exports.inject = ["slots"];
		exports.apply = apply;
		return module.exports;
	}
});
