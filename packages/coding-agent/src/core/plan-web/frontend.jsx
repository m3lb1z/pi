import hljs from "highlight.js";
import {
	Check,
	Code2,
	Copy,
	Highlighter,
	Maximize2,
	MessageSquareText,
	Minimize2,
	Plus,
	RotateCcw,
	Send,
	Trash2,
	Workflow,
	X,
	ZoomIn,
	ZoomOut,
} from "lucide-react";
import { marked } from "marked";
import mermaid from "mermaid";
import React, { useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { formatAnnotationFeedback } from "./annotation-feedback.ts";

const labels = {
	draft: "Borrador",
	planning: "Planificando",
	review: "Listo para revisión",
	approving: "Aprobando",
	executing: "Ejecutando",
	completed: "Completado",
	blocked: "Bloqueado",
	failed: "Fallido",
};

const token = location.hash.slice(1) || sessionStorage.getItem("pi-plan-token") || "";
sessionStorage.setItem("pi-plan-token", token);
history.replaceState(null, "", location.pathname);

function escapeHtml(text) {
	return String(text)
		.replaceAll("&", "&amp;")
		.replaceAll("<", "&lt;")
		.replaceAll(">", "&gt;")
		.replaceAll('"', "&quot;")
		.replaceAll("'", "&#39;");
}

function sanitizeMarkdownUrl(value) {
	const href = String(value || "")
		.trim()
		.replace(/[\u0000-\u001f\u007f]/g, "");
	if (!href) return href;
	const scheme = href.match(/^([A-Za-z][A-Za-z0-9+.-]*):/);
	return scheme && !/^(https?|mailto|tel)$/i.test(scheme[1]) ? null : href;
}

marked.use({
	breaks: true,
	gfm: true,
	tokenizer: {
		html() {
			return undefined;
		},
		tag() {
			return undefined;
		},
	},
	renderer: {
		link(linkToken) {
			const href = sanitizeMarkdownUrl(linkToken.href);
			if (href === null) return this.parser.parseInline(linkToken.tokens);
			const title = linkToken.title ? ` title="${escapeHtml(linkToken.title)}"` : "";
			return `<a href="${escapeHtml(href)}"${title} target="_blank" rel="noopener noreferrer">${this.parser.parseInline(linkToken.tokens)}</a>`;
		},
		image(imageToken) {
			const href = sanitizeMarkdownUrl(imageToken.href);
			if (href === null) return escapeHtml(imageToken.text || "");
			const title = imageToken.title ? ` title="${escapeHtml(imageToken.title)}"` : "";
			return `<img src="${escapeHtml(href)}" alt="${escapeHtml(imageToken.text || "")}"${title}>`;
		},
		codespan(codeToken) {
			return `<code>${escapeHtml(codeToken.text)}</code>`;
		},
		code(codeToken) {
			const language = (codeToken.lang || "").trim().split(/\s+/, 1)[0].toLowerCase();
			return `<pre><code class="language-${escapeHtml(language)}">${escapeHtml(codeToken.text)}</code></pre>`;
		},
	},
});

mermaid.initialize({
	startOnLoad: false,
	securityLevel: "strict",
	theme: matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "neutral",
	flowchart: { curve: "basis", htmlLabels: true },
	themeVariables: {
		primaryColor: "#2563eb",
		primaryTextColor: "#f8fafc",
		primaryBorderColor: "#64748b",
		lineColor: "#64748b",
		secondaryColor: "#172033",
		tertiaryColor: "#0f172a",
		edgeLabelBackground: "#172033",
	},
});

let diagramSequence = 0;

function acceptedTextNodes(container) {
	const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT, {
		acceptNode(node) {
			return node.parentElement?.closest("[data-annotation-ignore]")
				? NodeFilter.FILTER_REJECT
				: NodeFilter.FILTER_ACCEPT;
		},
	});
	const nodes = [];
	while (walker.nextNode()) nodes.push(walker.currentNode);
	return nodes;
}

function selectionOffsets(container, range) {
	const nodes = acceptedTextNodes(container);
	let cursor = 0;
	let start;
	let end;
	for (const node of nodes) {
		if (node === range.startContainer) start = cursor + range.startOffset;
		if (node === range.endContainer) end = cursor + range.endOffset;
		cursor += node.textContent.length;
	}
	return start === undefined || end === undefined ? null : { start, end };
}

function rangeFromOffsets(container, start, end) {
	const range = document.createRange();
	let cursor = 0;
	let hasStart = false;
	for (const node of acceptedTextNodes(container)) {
		const next = cursor + node.textContent.length;
		if (!hasStart && start >= cursor && start <= next) {
			range.setStart(node, Math.min(start - cursor, node.textContent.length));
			hasStart = true;
		}
		if (hasStart && end >= cursor && end <= next) {
			range.setEnd(node, Math.min(end - cursor, node.textContent.length));
			return range;
		}
		cursor = next;
	}
	return null;
}

function sourceLineForSelection(content, text) {
	const exactIndex = content.indexOf(text);
	const firstLine = text
		.split("\n")
		.map((line) => line.trim())
		.find(Boolean);
	const fallbackIndex = firstLine ? content.indexOf(firstLine) : -1;
	const index = exactIndex >= 0 ? exactIndex : fallbackIndex;
	return index < 0 ? 1 : content.slice(0, index).split("\n").length;
}

function IconButton({ active = false, disabled = false, label, onClick, children }) {
	return (
		<button
			type="button"
			className={`icon-button${active ? " active" : ""}`}
			aria-label={label}
			disabled={disabled}
			title={label}
			onClick={onClick}
		>
			{children}
		</button>
	);
}

function MermaidBlock({ source }) {
	const [svg, setSvg] = useState("");
	const [error, setError] = useState("");
	const [showSource, setShowSource] = useState(false);
	const [expanded, setExpanded] = useState(false);
	const [scale, setScale] = useState(1);
	const [pan, setPan] = useState({ x: 0, y: 0 });
	const [dragging, setDragging] = useState(false);
	const drag = useRef(null);

	useEffect(() => {
		let cancelled = false;
		const id = `pi-plan-mermaid-${++diagramSequence}`;
		mermaid
			.render(id, source)
			.then(({ svg: renderedSvg }) => {
				if (cancelled) return;
				const documentNode = new DOMParser().parseFromString(renderedSvg, "image/svg+xml");
				const svgNode = documentNode.documentElement;
				svgNode.removeAttribute("width");
				svgNode.removeAttribute("height");
				svgNode.setAttribute("preserveAspectRatio", "xMidYMid meet");
				setSvg(new XMLSerializer().serializeToString(svgNode));
				setError("");
			})
			.catch((renderError) => {
				if (cancelled) return;
				setSvg("");
				setError(renderError instanceof Error ? renderError.message : "No se pudo renderizar el diagrama.");
			});
		return () => {
			cancelled = true;
		};
	}, [source]);

	useEffect(() => {
		if (!expanded) return undefined;
		const previousOverflow = document.body.style.overflow;
		document.body.style.overflow = "hidden";
		return () => {
			document.body.style.overflow = previousOverflow;
		};
	}, [expanded]);

	const resetView = () => {
		setScale(1);
		setPan({ x: 0, y: 0 });
	};

	const startDrag = (event) => {
		if (showSource) return;
		event.currentTarget.setPointerCapture(event.pointerId);
		drag.current = { clientX: event.clientX, clientY: event.clientY, panX: pan.x, panY: pan.y };
		setDragging(true);
	};

	const moveDrag = (event) => {
		if (!drag.current) return;
		setPan({
			x: drag.current.panX + event.clientX - drag.current.clientX,
			y: drag.current.panY + event.clientY - drag.current.clientY,
		});
	};

	const stopDrag = () => {
		drag.current = null;
		setDragging(false);
	};

	return (
		<section className={`mermaid-card${expanded ? " expanded" : ""}`} aria-label="Diagrama Mermaid">
			<div className="mermaid-toolbar">
				<span className="mermaid-label">Mermaid</span>
				<IconButton active={!showSource} label="Ver diagrama" onClick={() => setShowSource(false)}>
					<Workflow />
				</IconButton>
				<IconButton active={showSource} label="Ver código fuente" onClick={() => setShowSource(true)}>
					<Code2 />
				</IconButton>
				{!showSource && (
					<>
						<IconButton label="Alejar" onClick={() => setScale((value) => Math.max(0.35, value - 0.15))}>
							<ZoomOut />
						</IconButton>
						<IconButton label="Restablecer vista" onClick={resetView}>
							<RotateCcw />
						</IconButton>
						<IconButton label="Acercar" onClick={() => setScale((value) => Math.min(3, value + 0.15))}>
							<ZoomIn />
						</IconButton>
					</>
				)}
				<IconButton label={expanded ? "Cerrar vista ampliada" : "Ampliar diagrama"} onClick={() => setExpanded(!expanded)}>
					{expanded ? <Minimize2 /> : <Maximize2 />}
				</IconButton>
			</div>
			{showSource ? (
				<pre className="mermaid-source">
					<code className="hljs language-mermaid">{source}</code>
				</pre>
			) : error ? (
				<pre className="mermaid-error">{error}</pre>
			) : (
				<div
					className={`diagram-viewport${dragging ? " dragging" : ""}`}
					onPointerDown={startDrag}
					onPointerMove={moveDrag}
					onPointerUp={stopDrag}
					onPointerCancel={stopDrag}
				>
					<div
						className="diagram-canvas"
						style={{ transform: `translate(${pan.x}px, ${pan.y}px) scale(${scale})` }}
						dangerouslySetInnerHTML={{ __html: svg }}
					/>
				</div>
			)}
		</section>
	);
}

function Markdown({ annotations, content, onSelection, selection }) {
	const container = useRef(null);
	const html = useMemo(() => marked.parse(content), [content]);

	useEffect(() => {
		if (!container.current) return undefined;
		container.current.innerHTML = html;
		const roots = [];
		for (const code of container.current.querySelectorAll("pre > code")) {
			if (code.classList.contains("language-mermaid")) {
				const wrapper = document.createElement("div");
				const offsetText = document.createElement("span");
				const host = document.createElement("div");
				offsetText.className = "annotation-offset-text";
				offsetText.textContent = code.textContent || "";
				host.dataset.annotationIgnore = "";
				wrapper.append(offsetText, host);
				code.parentElement.replaceWith(wrapper);
				const root = createRoot(host);
				root.render(<MermaidBlock source={code.textContent || ""} />);
				roots.push(root);
				continue;
			}
			hljs.highlightElement(code);
		}
		if (globalThis.CSS?.highlights && globalThis.Highlight) {
			const commentRanges = annotations
				.filter((annotation) => annotation.type === "comment")
				.map((annotation) => rangeFromOffsets(container.current, annotation.start, annotation.end))
				.filter(Boolean);
			const deletionRanges = annotations
				.filter((annotation) => annotation.type === "deletion")
				.map((annotation) => rangeFromOffsets(container.current, annotation.start, annotation.end))
				.filter(Boolean);
			CSS.highlights.set("plan-comment", new Highlight(...commentRanges));
			CSS.highlights.set("plan-deletion", new Highlight(...deletionRanges));
			const selectionRange = selection
				? rangeFromOffsets(container.current, selection.start, selection.end)
				: null;
			CSS.highlights.set("plan-selection", new Highlight(...(selectionRange ? [selectionRange] : [])));
		}
		return () => {
			globalThis.CSS?.highlights?.delete("plan-comment");
			globalThis.CSS?.highlights?.delete("plan-deletion");
			globalThis.CSS?.highlights?.delete("plan-selection");
			for (const root of roots) root.unmount();
		};
	}, [annotations, html, selection]);

	const captureSelection = () => {
		const selection = window.getSelection();
		if (!selection || selection.isCollapsed || selection.rangeCount === 0 || !container.current) return;
		const range = selection.getRangeAt(0);
		if (!container.current.contains(range.commonAncestorContainer)) return;
		const offsets = selectionOffsets(container.current, range);
		const rawText = selection.toString();
		const text = rawText.trim();
		if (!offsets || !text) return;
		const leadingWhitespace = rawText.length - rawText.trimStart().length;
		onSelection({
			start: offsets.start + leadingWhitespace,
			end: offsets.end - (rawText.length - rawText.trimEnd().length),
			text,
			line: sourceLineForSelection(content, text),
		});
	};

	return (
		<div
			ref={container}
			className="markdown"
			onMouseUp={captureSelection}
			onKeyUp={captureSelection}
			dangerouslySetInnerHTML={{ __html: html }}
		/>
	);
}

function SelectionToolbar({ selection, onCancel, onComment, onDelete }) {
	const [position, setPosition] = useState(null);

	useEffect(() => {
		let frame;
		const updatePosition = () => {
			cancelAnimationFrame(frame);
			frame = requestAnimationFrame(() => {
				const container = document.querySelector(".markdown");
				const range = container ? rangeFromOffsets(container, selection.start, selection.end) : null;
				if (!range) return;
				const rect = range.getBoundingClientRect();
				if (rect.bottom < 58 || rect.top > innerHeight) {
					setPosition(null);
					return;
				}
				setPosition({
					left: Math.max(94, Math.min(innerWidth - 94, rect.left + rect.width / 2)),
					top: rect.top > 68 ? rect.top - 10 : rect.bottom + 10,
					below: rect.top <= 68,
				});
			});
		};
		updatePosition();
		addEventListener("resize", updatePosition);
		addEventListener("scroll", updatePosition, true);
		return () => {
			cancelAnimationFrame(frame);
			removeEventListener("resize", updatePosition);
			removeEventListener("scroll", updatePosition, true);
		};
	}, [selection]);

	if (!position) return null;
	return (
		<div
			className={`selection-toolbar${position.below ? " below" : ""}`}
			style={{ left: position.left, top: position.top }}
			role="toolbar"
			aria-label="Acciones para la selección"
		>
			<IconButton label="Comentar selección" onClick={onComment}>
				<MessageSquareText />
			</IconButton>
			<IconButton label="Eliminar selección" onClick={onDelete}>
				<Trash2 />
			</IconButton>
			<span className="selection-toolbar-divider" />
			<IconButton label="Cancelar selección" onClick={onCancel}>
				<X />
			</IconButton>
		</div>
	);
}

function ActionButton({ className = "", disabled, icon: Icon, label, onClick }) {
	return (
		<button type="button" className={`button ${className}`} disabled={disabled} onClick={onClick}>
			<Icon aria-hidden="true" />
			<span>{label}</span>
		</button>
	);
}

function GlobalAnnotationModal({ onCancel, onSubmit }) {
	const [value, setValue] = useState("");

	return (
		<div className="modal-backdrop" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && onCancel()}>
			<form
				className="modal"
				role="dialog"
				aria-modal="true"
				aria-label="Agregar cambio general"
				onSubmit={(event) => {
					event.preventDefault();
					if (value.trim()) onSubmit(value.trim());
				}}
			>
				<h2>Cambio general</h2>
				<p>Describe un cambio que aplica al plan completo.</p>
				<textarea
					autoFocus
					placeholder="Describe el cambio requerido…"
					value={value}
					onChange={(event) => setValue(event.target.value)}
				/>
				<div className="modal-actions">
					<button type="button" className="button" onClick={onCancel}>
						<X aria-hidden="true" />
						Cancelar
					</button>
					<button type="submit" className="button primary" disabled={!value.trim()}>
						<Check aria-hidden="true" />
						Agregar
					</button>
				</div>
			</form>
		</div>
	);
}

function CommentModal({ selection, onCancel, onSubmit }) {
	const [comment, setComment] = useState("");
	return (
		<div className="modal-backdrop" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && onCancel()}>
			<form
				className="modal"
				role="dialog"
				aria-modal="true"
				aria-label="Agregar comentario"
				onSubmit={(event) => {
					event.preventDefault();
					if (comment.trim()) onSubmit(comment.trim());
				}}
			>
				<h2>Agregar comentario</h2>
				<blockquote className="selection-preview">{selection.text}</blockquote>
				<textarea
					autoFocus
					placeholder="Describe el cambio requerido…"
					value={comment}
					onChange={(event) => setComment(event.target.value)}
				/>
				<div className="modal-actions">
					<button type="button" className="button" onClick={onCancel}>
						<X aria-hidden="true" />
						Cancelar
					</button>
					<button type="submit" className="button primary" disabled={!comment.trim()}>
						<MessageSquareText aria-hidden="true" />
						Agregar
					</button>
				</div>
			</form>
		</div>
	);
}

function ConfirmDialog({ busy, description, onCancel, onConfirm, title }) {
	return (
		<div
			className="modal-backdrop"
			role="presentation"
			onKeyDown={(event) => event.key === "Escape" && onCancel()}
			onMouseDown={(event) => event.target === event.currentTarget && onCancel()}
		>
			<section
				className="modal confirm-dialog"
				role="alertdialog"
				aria-describedby="confirm-dialog-description"
				aria-labelledby="confirm-dialog-title"
			>
				<div className="confirm-dialog-icon" aria-hidden="true">
					<Trash2 />
				</div>
				<h2 id="confirm-dialog-title">{title}</h2>
				<p id="confirm-dialog-description">{description}</p>
				<div className="modal-actions">
					<button type="button" className="button" disabled={busy} autoFocus onClick={onCancel}>
						<X aria-hidden="true" />
						Cancelar
					</button>
					<button type="button" className="button destructive" disabled={busy} onClick={onConfirm}>
						<Trash2 aria-hidden="true" />
						Descartar
					</button>
				</div>
			</section>
		</div>
	);
}

function AnnotationSidebar({ annotations, busy, canSubmit, copied, onAddGlobal, onCopy, onRemove, onSelect, onSubmit, activity }) {
	return (
		<aside className="annotation-sidebar">
			<div className="annotation-header">
				<h2>
					Anotaciones <span className="annotation-count">{annotations.length}</span>
				</h2>
				<IconButton disabled={!canSubmit || busy} label="Agregar cambio general" onClick={onAddGlobal}>
					<Plus />
				</IconButton>
			</div>
			<div className="annotation-list">
				{annotations.length === 0 ? (
					<div className="annotation-empty">
						<Highlighter aria-hidden="true" />
						<p>Selecciona texto o agrega un cambio general.</p>
					</div>
				) : (
					annotations.map((annotation, index) => (
						<article key={annotation.id} className={`annotation-item ${annotation.type}`}>
							<div className="annotation-item-header">
								{annotation.type === "global" ? (
									<span className="annotation-link">
										<MessageSquareText aria-hidden="true" />
										Cambio general
									</span>
								) : (
									<button type="button" className="annotation-link" onClick={() => onSelect(annotation)}>
										<Highlighter aria-hidden="true" />
										{annotation.type === "comment" ? "Comentario" : "Eliminación"} · línea {annotation.line}
									</button>
								)}
								<IconButton label={`Eliminar anotación ${index + 1}`} onClick={() => onRemove(annotation.id)}>
									<X />
								</IconButton>
							</div>
							{annotation.type !== "global" && <blockquote>{annotation.text}</blockquote>}
							{annotation.type !== "deletion" && <p>{annotation.comment}</p>}
						</article>
					))
				)}
			</div>
			<details className="activity-details">
				<summary>Actividad del agente</summary>
				<pre className="activity">{activity}</pre>
			</details>
			<div className="annotation-actions">
				<button type="button" className="button" disabled={annotations.length === 0} onClick={onCopy}>
					<Copy aria-hidden="true" />
					{copied ? "Copiado" : "Copiar"}
				</button>
				<button
					type="button"
					className="button primary"
					disabled={annotations.length === 0 || !canSubmit || busy}
					onClick={onSubmit}
				>
					<Send aria-hidden="true" />
					Refinar
				</button>
			</div>
		</aside>
	);
}

function App() {
	const [state, setState] = useState(null);
	const [connected, setConnected] = useState(false);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState("");
	const [showDiscardConfirmation, setShowDiscardConfirmation] = useState(false);
	const [showGlobalAnnotation, setShowGlobalAnnotation] = useState(false);
	const [annotations, setAnnotations] = useState([]);
	const [pendingSelection, setPendingSelection] = useState(null);
	const [commentSelection, setCommentSelection] = useState(null);
	const [copied, setCopied] = useState(false);
	const revision = state?.revision;

	useEffect(() => {
		const events = new EventSource(`/events?token=${encodeURIComponent(token)}`);
		events.onmessage = (event) => {
			setConnected(true);
			setState(JSON.parse(event.data));
		};
		events.onerror = () => {
			setConnected(false);
			setError("Conexión perdida. Si reiniciaste Pi, abre la página otra vez con /plan.");
		};
		events.onopen = () => {
			setConnected(true);
			setError("");
		};
		return () => events.close();
	}, []);

	useEffect(() => {
		setAnnotations([]);
		setPendingSelection(null);
		setCommentSelection(null);
		setShowDiscardConfirmation(false);
		setShowGlobalAnnotation(false);
	}, [revision]);

	const action = async (actionName, feedback = "") => {
		if (!state || busy) return;
		setBusy(true);
		setError("");
		try {
			const response = await fetch("/action", {
				method: "POST",
				headers: { "Content-Type": "application/json", "X-Plan-Token": token },
				body: JSON.stringify({ action: actionName, revision: state.revision, feedback }),
			});
			const result = await response.json();
			if (!response.ok) throw new Error(result.error);
			return true;
		} catch (actionError) {
			setError(actionError instanceof Error ? actionError.message : String(actionError));
			return false;
		} finally {
			setBusy(false);
		}
	};

	const idle = state && ["review", "draft", "blocked", "failed", "completed"].includes(state.status);
	const hasPlan = Boolean(state?.content.trim());
	const activity = state?.result || state?.activity || "Sin actividad todavía.";
	const clearNativeSelection = () => window.getSelection()?.removeAllRanges();
	const addAnnotation = (selection, type, comment = "") => {
		setAnnotations((current) => [
			...current,
			{ ...selection, id: crypto.randomUUID(), type, comment },
		]);
		setPendingSelection(null);
		setCommentSelection(null);
		clearNativeSelection();
	};
	const focusAnnotation = (annotation) => {
		if (annotation.type === "global") return;
		const container = document.querySelector(".markdown");
		if (!container) return;
		const range = rangeFromOffsets(container, annotation.start, annotation.end);
		const target = range?.startContainer.parentElement;
		target?.scrollIntoView({ behavior: "smooth", block: "center" });
	};
	const copyAnnotations = async () => {
		try {
			await navigator.clipboard.writeText(formatAnnotationFeedback(annotations));
			setCopied(true);
			setTimeout(() => setCopied(false), 1600);
		} catch (copyError) {
			setError(copyError instanceof Error ? copyError.message : "No se pudieron copiar las anotaciones.");
		}
	};
	const submitAnnotations = async () => {
		if (await action("revise", formatAnnotationFeedback(annotations))) setAnnotations([]);
	};

	return (
		<div className="app-shell">
			<header className="navbar">
				<h1>Pi Planning</h1>
				<nav className="navbar-actions" aria-label="Acciones del plan">
					<ActionButton
						className="primary"
						disabled={busy || !connected || state?.status !== "review"}
						icon={Check}
						label="Aprobar"
						onClick={() => action("approve")}
					/>
					<ActionButton
						className="danger"
						disabled={busy || !connected || !idle || !hasPlan}
						icon={Trash2}
						label="Descartar"
						onClick={() => setShowDiscardConfirmation(true)}
					/>
				</nav>
				<div className="status-group">
					<span className="status" data-connected={connected}>
						<span className="status-dot" />
						{connected && state ? labels[state.status] : "Desconectado"}
					</span>
				</div>
			</header>

			{error && (
				<p className="error" role="alert">
					{error}
				</p>
			)}

			<main className="review-layout">
				<section className="plan-surface">
					<div className="plan-content">
						{hasPlan ? (
							<Markdown
								annotations={annotations}
								content={state.content}
								onSelection={idle && !busy ? setPendingSelection : () => {}}
								selection={pendingSelection}
							/>
						) : (
							<p className="empty">Esperando el plan…</p>
						)}
					</div>
				</section>
				<AnnotationSidebar
					annotations={annotations}
					activity={activity}
					busy={busy}
					canSubmit={Boolean(connected && idle)}
					copied={copied}
					onAddGlobal={() => setShowGlobalAnnotation(true)}
					onCopy={copyAnnotations}
					onRemove={(id) => setAnnotations((current) => current.filter((annotation) => annotation.id !== id))}
					onSelect={focusAnnotation}
					onSubmit={submitAnnotations}
				/>
			</main>
			{pendingSelection && idle && !busy && (
				<SelectionToolbar
					selection={pendingSelection}
					onCancel={() => {
						setPendingSelection(null);
						clearNativeSelection();
					}}
					onComment={() => {
						setCommentSelection(pendingSelection);
						setPendingSelection(null);
					}}
					onDelete={() => addAnnotation(pendingSelection, "deletion")}
				/>
			)}

			{showGlobalAnnotation && (
				<GlobalAnnotationModal
					onCancel={() => setShowGlobalAnnotation(false)}
					onSubmit={(comment) => {
						setAnnotations((current) => [
							...current,
							{ id: crypto.randomUUID(), type: "global", comment },
						]);
						setShowGlobalAnnotation(false);
					}}
				/>
			)}
			{commentSelection && (
				<CommentModal
					selection={commentSelection}
					onCancel={() => setCommentSelection(null)}
					onSubmit={(comment) => addAnnotation(commentSelection, "comment", comment)}
				/>
			)}
			{showDiscardConfirmation && (
				<ConfirmDialog
					busy={busy}
					title="Descartar plan"
					description="El contenido del plan actual se eliminará. Esta acción no se puede deshacer."
					onCancel={() => setShowDiscardConfirmation(false)}
					onConfirm={async () => {
						if (await action("discard")) setShowDiscardConfirmation(false);
					}}
				/>
			)}
		</div>
	);
}

createRoot(document.getElementById("root")).render(<App />);
