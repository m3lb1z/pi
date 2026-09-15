import { Copy, Highlighter, MessageSquareText, Plus, Send, X } from "lucide-react";
import React from "react";
import { AttachmentPanel } from "./attachments.jsx";
import { IconButton } from "./buttons.jsx";

export function ReviewSidebar({
	annotations,
	attachments,
	busy,
	canManageAttachments,
	canSubmit,
	copied,
	onAddGlobal,
	onCopy,
	onRemove,
	onRemoveAttachment,
	onSelect,
	onSubmit,
	onUploadAttachments,
	activity,
}) {
	return (
		<aside className="annotation-sidebar">
			<AnnotationHeader count={annotations.length} disabled={!canSubmit || busy} onAddGlobal={onAddGlobal} />
			<AnnotationList annotations={annotations} onRemove={onRemove} onSelect={onSelect} />
			<AttachmentPanel attachments={attachments} busy={busy} canManage={canManageAttachments} onRemove={onRemoveAttachment} onUpload={onUploadAttachments} />
			<AgentActivity activity={activity} />
			<AnnotationActions busy={busy} canSubmit={canSubmit} copied={copied} count={annotations.length} onCopy={onCopy} onSubmit={onSubmit} />
		</aside>
	);
}

function AnnotationHeader({ count, disabled, onAddGlobal }) {
	return (
		<div className="annotation-header">
			<h2>Anotaciones <span className="annotation-count">{count}</span></h2>
			<IconButton disabled={disabled} label="Agregar cambio general" onClick={onAddGlobal}><Plus /></IconButton>
		</div>
	);
}

function AnnotationList({ annotations, onRemove, onSelect }) {
	return (
		<div className="annotation-list">
			{annotations.length === 0 ? (
				<div className="annotation-empty"><Highlighter aria-hidden="true" /><p>Selecciona texto o agrega un cambio general.</p></div>
			) : (
				annotations.map((annotation, index) => (
					<AnnotationItem annotation={annotation} index={index} key={annotation.id} onRemove={onRemove} onSelect={onSelect} />
				))
			)}
		</div>
	);
}

function AnnotationItem({ annotation, index, onRemove, onSelect }) {
	return (
		<article className={`annotation-item ${annotation.type}`}>
			<div className="annotation-item-header">
				{annotation.type === "global" ? (
					<span className="annotation-link"><MessageSquareText aria-hidden="true" />Cambio general</span>
				) : (
					<button type="button" className="annotation-link" onClick={() => onSelect(annotation)}><Highlighter aria-hidden="true" />Comentario · línea {annotation.line}</button>
				)}
				<IconButton label={`Eliminar anotación ${index + 1}`} onClick={() => onRemove(annotation.id)}><X /></IconButton>
			</div>
			{annotation.type !== "global" && <blockquote>{annotation.text}</blockquote>}
			<p>{annotation.comment}</p>
		</article>
	);
}

function AgentActivity({ activity }) {
	return <details className="activity-details"><summary>Actividad del agente</summary><pre className="activity">{activity}</pre></details>;
}

function AnnotationActions({ busy, canSubmit, copied, count, onCopy, onSubmit }) {
	return (
		<div className="annotation-actions">
			<button type="button" className="button" disabled={count === 0} onClick={onCopy}><Copy aria-hidden="true" />{copied ? "Copiado" : "Copiar"}</button>
			<button type="button" className="button primary" disabled={count === 0 || !canSubmit || busy} onClick={onSubmit}><Send aria-hidden="true" />Refinar</button>
		</div>
	);
}
