import { Check, SquarePen, Trash2 } from "lucide-react";
import React from "react";
import { ActionButton } from "./buttons.jsx";
import { MarkdownEditor } from "./dialogs.jsx";
import { Markdown } from "./markdown.jsx";

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

export function PlanHeader({ busy, connected, hasPlan, idle, onApprove, onDiscard, onEdit, status }) {
	return (
		<header className="navbar">
			<h1>Pi Planning</h1>
			<nav className="navbar-actions" aria-label="Acciones del plan">
				<ActionButton disabled={busy || !connected || !idle || !hasPlan} icon={SquarePen} label="Editar" onClick={onEdit} />
				<ActionButton className="primary" disabled={busy || !connected || status !== "review"} icon={Check} label="Aprobar" onClick={onApprove} />
				<ActionButton className="danger" disabled={busy || !connected || !idle || !hasPlan} icon={Trash2} label="Descartar" onClick={onDiscard} />
			</nav>
			<div className="status-group">
				<span className="status" data-connected={connected}>
					<span className="status-dot" />
					{connected && status ? labels[status] : "Desconectado"}
				</span>
			</div>
		</header>
	);
}

export function ErrorBanner({ error }) {
	if (!error) return null;
	return <p className="error" role="alert">{error}</p>;
}

export function PlanSurface({ annotations, busy, content, editorSelection, idle, onCancelEdit, onSave, onSelection, selection }) {
	return (
		<section className="plan-surface">
			<div className="plan-content">
				{!content.trim() ? (
					<p className="empty">Esperando el plan…</p>
				) : editorSelection ? (
					<MarkdownEditor busy={busy} content={content} selection={editorSelection} onCancel={onCancelEdit} onSave={onSave} />
				) : (
					<Markdown annotations={annotations} content={content} onSelection={idle && !busy ? onSelection : () => {}} selection={selection} />
				)}
			</div>
		</section>
	);
}
