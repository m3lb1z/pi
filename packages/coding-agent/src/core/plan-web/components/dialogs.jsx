import { Check, MessageSquareText, Trash2, X } from "lucide-react";
import React, { useEffect, useMemo, useRef, useState } from "react";
import { SelectionToolbar } from "./markdown.jsx";

export function GlobalAnnotationModal({ onCancel, onSubmit }) {
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
				<textarea autoFocus placeholder="Describe el cambio requerido…" value={value} onChange={(event) => setValue(event.target.value)} />
				<div className="modal-actions">
					<button type="button" className="button" onClick={onCancel}><X aria-hidden="true" />Cancelar</button>
					<button type="submit" className="button primary" disabled={!value.trim()}><Check aria-hidden="true" />Agregar</button>
				</div>
			</form>
		</div>
	);
}

export function CommentModal({ selection, onCancel, onSubmit }) {
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
				<textarea autoFocus placeholder="Describe el cambio requerido…" value={comment} onChange={(event) => setComment(event.target.value)} />
				<div className="modal-actions">
					<button type="button" className="button" onClick={onCancel}><X aria-hidden="true" />Cancelar</button>
					<button type="submit" className="button primary" disabled={!comment.trim()}><MessageSquareText aria-hidden="true" />Agregar</button>
				</div>
			</form>
		</div>
	);
}

export function MarkdownEditor({ busy, content, selection, onCancel, onSave }) {
	const normalizedContent = useMemo(() => content.replace(/\r\n?/g, "\n"), [content]);
	const [value, setValue] = useState(normalizedContent);
	const textarea = useRef(null);

	useEffect(() => {
		if (!textarea.current) return;
		const borderHeight = textarea.current.offsetHeight - textarea.current.clientHeight;
		textarea.current.style.height = "0";
		textarea.current.style.height = `${textarea.current.scrollHeight + borderHeight}px`;
	}, [value]);

	useEffect(() => {
		const resize = () => {
			if (!textarea.current) return;
			const borderHeight = textarea.current.offsetHeight - textarea.current.clientHeight;
			textarea.current.style.height = "0";
			textarea.current.style.height = `${textarea.current.scrollHeight + borderHeight}px`;
		};
		addEventListener("resize", resize);
		return () => removeEventListener("resize", resize);
	}, []);

	useEffect(() => {
		const exactIndex = selection.text ? normalizedContent.indexOf(selection.text) : -1;
		const hasUniqueExactMatch = exactIndex >= 0 && normalizedContent.indexOf(selection.text, exactIndex + selection.text.length) === -1;
		const linesBeforeSelection = normalizedContent.split("\n").slice(0, Math.max(0, selection.line - 1));
		const lineStart = linesBeforeSelection.join("\n").length + (linesBeforeSelection.length > 0 ? 1 : 0);
		const start = hasUniqueExactMatch ? exactIndex : lineStart;
		textarea.current?.focus();
		textarea.current?.setSelectionRange(start, hasUniqueExactMatch ? exactIndex + selection.text.length : start);
	}, [normalizedContent, selection]);

	return (
		<form className="markdown-editor" aria-label="Editar Markdown" onSubmit={(event) => { event.preventDefault(); onSave(value); }}>
			<div className="markdown-editor-header">
				<div><h2>Editar Markdown</h2><p>Edita directamente el contenido raw del plan.</p></div>
				<div className="markdown-editor-actions">
					<button type="button" className="button" disabled={busy} onClick={onCancel}><X aria-hidden="true" />Cancelar</button>
					<button type="submit" className="button primary" disabled={busy || value === normalizedContent}><Check aria-hidden="true" />Guardar</button>
				</div>
			</div>
			<textarea ref={textarea} rows="1" spellCheck="false" value={value} onChange={(event) => setValue(event.target.value)} />
		</form>
	);
}

function ConfirmDialog({ busy, description, onCancel, onConfirm, title }) {
	return (
		<div className="modal-backdrop" role="presentation" onKeyDown={(event) => event.key === "Escape" && onCancel()} onMouseDown={(event) => event.target === event.currentTarget && onCancel()}>
			<section className="modal confirm-dialog" role="alertdialog" aria-describedby="confirm-dialog-description" aria-labelledby="confirm-dialog-title">
				<div className="confirm-dialog-icon" aria-hidden="true"><Trash2 /></div>
				<h2 id="confirm-dialog-title">{title}</h2>
				<p id="confirm-dialog-description">{description}</p>
				<div className="modal-actions">
					<button type="button" className="button" disabled={busy} autoFocus onClick={onCancel}><X aria-hidden="true" />Cancelar</button>
					<button type="button" className="button destructive" disabled={busy} onClick={onConfirm}><Trash2 aria-hidden="true" />Descartar</button>
				</div>
			</section>
		</div>
	);
}

export function PlanOverlays({
	busy,
	commentSelection,
	idle,
	onAddGlobal,
	onCancelComment,
	onCancelDiscard,
	onCancelGlobal,
	onCancelSelection,
	onCommentSelection,
	onConfirmDiscard,
	onEditSelection,
	onSubmitComment,
	pendingSelection,
	showDiscardConfirmation,
	showGlobalAnnotation,
}) {
	return (
		<>
			{pendingSelection && idle && !busy && <SelectionToolbar selection={pendingSelection} onCancel={onCancelSelection} onComment={onCommentSelection} onEdit={onEditSelection} />}
			{showGlobalAnnotation && <GlobalAnnotationModal onCancel={onCancelGlobal} onSubmit={onAddGlobal} />}
			{commentSelection && <CommentModal selection={commentSelection} onCancel={onCancelComment} onSubmit={onSubmitComment} />}
			{showDiscardConfirmation && (
				<ConfirmDialog
					busy={busy}
					title="Descartar plan"
					description="El contenido y las imágenes anexas del plan actual se eliminarán. Esta acción no se puede deshacer."
					onCancel={onCancelDiscard}
					onConfirm={onConfirmDiscard}
				/>
			)}
		</>
	);
}
