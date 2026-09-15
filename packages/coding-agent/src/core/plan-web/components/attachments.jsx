import { ImagePlus, X } from "lucide-react";
import React, { useEffect, useRef, useState } from "react";
import { IconButton } from "./buttons.jsx";
import { planToken } from "./plan-token.js";

export function AttachmentPanel({ attachments, busy, canManage, onRemove, onUpload }) {
	const input = useRef(null);
	const [dragging, setDragging] = useState(false);
	const submitFiles = (files) => {
		const selected = [...files];
		if (selected.length > 0) onUpload(selected);
	};

	useEffect(() => {
		const pasteImages = (event) => {
			if (
				!canManage ||
				busy ||
				(event.target instanceof Element && event.target.closest("textarea, input, [contenteditable='true']"))
			)
				return;
			const images = [...event.clipboardData.items]
				.filter((item) => item.kind === "file" && item.type.startsWith("image/"))
				.map((item) => item.getAsFile())
				.filter(Boolean);
			if (images.length > 0) {
				event.preventDefault();
				onUpload(images);
			}
		};
		addEventListener("paste", pasteImages);
		return () => removeEventListener("paste", pasteImages);
	}, [busy, canManage, onUpload]);

	return (
		<section className="attachment-panel">
			<AttachmentHeader disabled={!canManage || busy} input={input} onSelect={submitFiles} />
			<AttachmentDropzone
				disabled={!canManage || busy}
				dragging={dragging}
				onDraggingChange={setDragging}
				onOpen={() => input.current?.click()}
				onSelect={submitFiles}
			/>
			<AttachmentList attachments={attachments} disabled={!canManage || busy} onRemove={onRemove} />
		</section>
	);
}

function AttachmentHeader({ disabled, input, onSelect }) {
	return (
		<div className="sidebar-panel-toolbar">
			<IconButton disabled={disabled} label="Agregar imágenes" onClick={() => input.current?.click()}><ImagePlus /></IconButton>
			<input
				ref={input}
				className="attachment-input"
				type="file"
				accept="image/png,image/jpeg,image/gif,image/webp,image/bmp"
				multiple
				onChange={(event) => {
					onSelect(event.target.files);
					event.target.value = "";
				}}
			/>
		</div>
	);
}

function AttachmentDropzone({ disabled, dragging, onDraggingChange, onOpen, onSelect }) {
	return (
		<button
			type="button"
			className={`attachment-dropzone${dragging ? " dragging" : ""}`}
			disabled={disabled}
			onClick={onOpen}
			onDragEnter={(event) => { event.preventDefault(); onDraggingChange(true); }}
			onDragOver={(event) => event.preventDefault()}
			onDragLeave={() => onDraggingChange(false)}
			onDrop={(event) => {
				event.preventDefault();
				onDraggingChange(false);
				if (!disabled) onSelect(event.dataTransfer.files);
			}}
		>
			<ImagePlus aria-hidden="true" />
			<span>Arrastra, pega o selecciona imágenes</span>
		</button>
	);
}

function AttachmentList({ attachments, disabled, onRemove }) {
	if (attachments.length === 0) return null;
	return (
		<div className="attachment-list">
			{attachments.map((attachment, index) => (
				<AttachmentItem attachment={attachment} disabled={disabled} index={index} key={attachment.id} onRemove={onRemove} />
			))}
		</div>
	);
}

function AttachmentItem({ attachment, disabled, index, onRemove }) {
	return (
		<article className="attachment-item">
			<img src={`/attachments/${attachment.id}?token=${encodeURIComponent(planToken)}`} alt={`Anexo ${index + 1}: ${attachment.name}`} />
			<div>
				<strong>{attachment.name}</strong>
				<span>Anexo {index + 1} · {(attachment.size / 1024).toFixed(0)} KiB</span>
			</div>
			<IconButton disabled={disabled} label={`Eliminar ${attachment.name}`} onClick={() => onRemove(attachment.id)}><X /></IconButton>
		</article>
	);
}
