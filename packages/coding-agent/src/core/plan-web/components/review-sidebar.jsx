import { Copy, Highlighter, MessageSquareText, Plus, Send, X } from "lucide-react";
import React from "react";
import { AttachmentPanel } from "./attachments.jsx";
import { IconButton } from "./buttons.jsx";

export function ReviewSidebar({
	activeTab,
	annotations,
	attachments,
	busy,
	canManageAttachments,
	canSubmit,
	copied,
	onAddGlobal,
	onCopy,
	onChangeTab,
	onRemove,
	onRemoveAttachment,
	onSelect,
	onSubmit,
	onUploadAttachments,
	activity,
}) {
	return (
		<aside className="annotation-sidebar">
			<div className="sidebar-tabs" role="tablist" aria-label="Panel de revisión" onKeyDown={(event) => {
				const nextTab = event.key === "ArrowRight" || event.key === "End" ? "images" : event.key === "ArrowLeft" || event.key === "Home" ? "annotations" : null;
				if (!nextTab) return;
				event.preventDefault();
				onChangeTab(nextTab);
				event.currentTarget.querySelector(`#${nextTab}-tab`)?.focus();
			}}>
				<button type="button" id="annotations-tab" role="tab" aria-controls="annotations-panel" aria-selected={activeTab === "annotations"} tabIndex={activeTab === "annotations" ? 0 : -1} onClick={() => onChangeTab("annotations")}>Anotaciones <span className="annotation-count">{annotations.length}</span></button>
				<button type="button" id="images-tab" role="tab" aria-controls="images-panel" aria-selected={activeTab === "images"} tabIndex={activeTab === "images" ? 0 : -1} onClick={() => onChangeTab("images")}>Imágenes <span className="annotation-count">{attachments.length}</span></button>
			</div>
			<div className="sidebar-tab-panel" id="annotations-panel" role="tabpanel" aria-labelledby="annotations-tab" hidden={activeTab !== "annotations"}>
				<AnnotationHeader disabled={!canSubmit || busy} onAddGlobal={onAddGlobal} />
				<AnnotationList annotations={annotations} onRemove={onRemove} onSelect={onSelect} />
				<AgentActivity activity={activity} />
				<AnnotationActions busy={busy} canSubmit={canSubmit} copied={copied} count={annotations.length} onCopy={onCopy} onSubmit={onSubmit} />
			</div>
			<div className="sidebar-tab-panel" id="images-panel" role="tabpanel" aria-labelledby="images-tab" hidden={activeTab !== "images"}>
				<AttachmentPanel attachments={attachments} busy={busy} canManage={canManageAttachments} onRemove={onRemoveAttachment} onUpload={onUploadAttachments} />
			</div>
		</aside>
	);
}

function AnnotationHeader({ disabled, onAddGlobal }) {
	return (
		<div className="sidebar-panel-toolbar">
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
