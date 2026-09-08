import hljs from "highlight.js";
import {
	Check,
	Code2,
	FilePlus2,
	Maximize2,
	MessageSquareText,
	Minimize2,
	RotateCcw,
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

function IconButton({ active = false, label, onClick, children }) {
	return (
		<button
			type="button"
			className={`icon-button${active ? " active" : ""}`}
			aria-label={label}
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

function Markdown({ content }) {
	const container = useRef(null);
	const html = useMemo(() => marked.parse(content), [content]);

	useEffect(() => {
		if (!container.current) return undefined;
		const roots = [];
		for (const code of container.current.querySelectorAll("pre > code")) {
			if (code.classList.contains("language-mermaid")) {
				const host = document.createElement("div");
				code.parentElement.replaceWith(host);
				const root = createRoot(host);
				root.render(<MermaidBlock source={code.textContent || ""} />);
				roots.push(root);
				continue;
			}
			hljs.highlightElement(code);
		}
		return () => {
			for (const root of roots) root.unmount();
		};
	}, [html]);

	return <div ref={container} className="markdown" dangerouslySetInnerHTML={{ __html: html }} />;
}

function ActionButton({ className = "", disabled, icon: Icon, label, onClick }) {
	return (
		<button type="button" className={`button ${className}`} disabled={disabled} onClick={onClick}>
			<Icon aria-hidden="true" />
			<span>{label}</span>
		</button>
	);
}

function TextModal({ kind, onCancel, onSubmit }) {
	const [value, setValue] = useState("");
	const revise = kind === "revise";
	const title = revise ? "Solicitar cambios" : "Crear un nuevo plan";
	const description = revise
		? "Describe qué debe corregir o ampliar el planner."
		: "Describe la tarea que debe reemplazar al plan actual.";

	return (
		<div className="modal-backdrop" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && onCancel()}>
			<form
				className="modal"
				role="dialog"
				aria-modal="true"
				aria-label={title}
				onSubmit={(event) => {
					event.preventDefault();
					if (value.trim()) onSubmit(value.trim());
				}}
			>
				<h2>{title}</h2>
				<p>{description}</p>
				<textarea autoFocus value={value} onChange={(event) => setValue(event.target.value)} />
				<div className="modal-actions">
					<button type="button" className="button" onClick={onCancel}>
						<X aria-hidden="true" />
						Cancelar
					</button>
					<button type="submit" className="button primary" disabled={!value.trim()}>
						<Check aria-hidden="true" />
						Enviar
					</button>
				</div>
			</form>
		</div>
	);
}

function App() {
	const [state, setState] = useState(null);
	const [connected, setConnected] = useState(false);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState("");
	const [modal, setModal] = useState(null);

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
		} catch (actionError) {
			setError(actionError instanceof Error ? actionError.message : String(actionError));
		} finally {
			setBusy(false);
		}
	};

	const idle = state && ["review", "draft", "blocked", "failed", "completed"].includes(state.status);
	const hasPlan = Boolean(state?.content.trim());
	const activity = state?.result || state?.activity || "Sin actividad todavía.";

	return (
		<div className="app-shell">
			<header className="topbar">
				<div>
					<p className="eyebrow">Pi planning</p>
					<h1>Plan actual</h1>
					<p className="project">{state?.project || "Esperando información del proyecto…"}</p>
				</div>
				<div className="status-group">
					<span className="status" data-connected={connected}>
						<span className="status-dot" />
						{connected && state ? labels[state.status] : "Desconectado"}
					</span>
					{state && <span className="revision">v{state.revision.slice(0, 7)}</span>}
				</div>
			</header>

			<nav className="toolbar" aria-label="Acciones del plan">
				<ActionButton
					className="primary"
					disabled={busy || !connected || state?.status !== "review"}
					icon={Check}
					label="Aprobar y ejecutar"
					onClick={() => action("approve")}
				/>
				<ActionButton
					disabled={busy || !connected || !idle || !hasPlan}
					icon={MessageSquareText}
					label="Solicitar cambios"
					onClick={() => setModal("revise")}
				/>
				<ActionButton
					disabled={busy || !connected || !idle}
					icon={FilePlus2}
					label="Crear nuevo plan"
					onClick={() => setModal("new")}
				/>
				<ActionButton
					className="danger"
					disabled={busy || !connected || !idle || !hasPlan}
					icon={Trash2}
					label="Descartar"
					onClick={() => confirm("¿Descartar el plan actual?") && action("discard")}
				/>
			</nav>

			{error && (
				<p className="error" role="alert">
					{error}
				</p>
			)}

			<main className="layout">
				<section className="card">
					<div className="card-header">
						<h2>Contenido del plan</h2>
					</div>
					<div className="card-body">
						{hasPlan ? <Markdown content={state.content} /> : <p className="empty">Esperando el plan…</p>}
					</div>
				</section>
				<aside className="card activity-card">
					<div className="card-header">
						<h2>Actividad y resultado</h2>
					</div>
					<div className="card-body">
						<pre className="activity">{activity}</pre>
					</div>
				</aside>
			</main>

			{modal && (
				<TextModal
					kind={modal}
					onCancel={() => setModal(null)}
					onSubmit={(feedback) => {
						setModal(null);
						action(modal, feedback);
					}}
				/>
			)}
		</div>
	);
}

createRoot(document.getElementById("root")).render(<App />);
