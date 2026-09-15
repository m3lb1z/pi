import React, { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { formatAnnotationFeedback } from "./annotation-feedback.ts";
import { PlanOverlays } from "./components/dialogs.jsx";
import { rangeFromOffsets } from "./components/markdown.jsx";
import { ErrorBanner, PlanHeader, PlanSurface } from "./components/plan-layout.jsx";
import { planToken } from "./components/plan-token.js";
import { ReviewSidebar } from "./components/review-sidebar.jsx";

function App() {
	const [state, setState] = useState(null);
	const [connected, setConnected] = useState(false);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState("");
	const [showDiscardConfirmation, setShowDiscardConfirmation] = useState(false);
	const [showGlobalAnnotation, setShowGlobalAnnotation] = useState(false);
	const [annotations, setAnnotations] = useState([]);
	const [sidebarTab, setSidebarTab] = useState("annotations");
	const [pendingSelection, setPendingSelection] = useState(null);
	const [commentSelection, setCommentSelection] = useState(null);
	const [editorSelection, setEditorSelection] = useState(null);
	const [copied, setCopied] = useState(false);
	const planContent = state?.content;

	useEffect(() => {
		const events = new EventSource(`/events?token=${encodeURIComponent(planToken)}`);
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
		setEditorSelection(null);
		setShowDiscardConfirmation(false);
		setShowGlobalAnnotation(false);
	}, [planContent]);

	const action = async (actionName, feedback = "") => {
		if (!state || busy) return;
		setBusy(true);
		setError("");
		try {
			const response = await fetch("/action", {
				method: "POST",
				headers: { "Content-Type": "application/json", "X-Plan-Token": planToken },
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
		setAnnotations((current) => [...current, { ...selection, id: crypto.randomUUID(), type, comment }]);
		setSidebarTab("annotations");
		setPendingSelection(null);
		setCommentSelection(null);
		clearNativeSelection();
	};
	const focusAnnotation = (annotation) => {
		if (annotation.type === "global") return;
		const container = document.querySelector(".markdown");
		if (!container) return;
		const range = rangeFromOffsets(container, annotation.start, annotation.end);
		range?.startContainer.parentElement?.scrollIntoView({ behavior: "smooth", block: "center" });
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
	const uploadAttachments = async (files) => {
		if (busy || files.length === 0) return;
		setSidebarTab("images");
		setBusy(true);
		setError("");
		try {
			for (const file of files) {
				const response = await fetch("/attachments", {
					method: "POST",
					headers: {
						"Content-Type": "application/octet-stream",
						"X-Plan-Token": planToken,
						"X-Plan-File-Name": encodeURIComponent(file.name || "clipboard-image.png"),
					},
					body: file,
				});
				const result = await response.json();
				if (!response.ok) throw new Error(result.error);
			}
		} catch (uploadError) {
			setError(uploadError instanceof Error ? uploadError.message : String(uploadError));
		} finally {
			setBusy(false);
		}
	};
	const removeAttachment = async (id) => {
		if (busy) return;
		setBusy(true);
		setError("");
		try {
			const response = await fetch(`/attachments/${id}`, {
				method: "DELETE",
				headers: { "X-Plan-Token": planToken },
			});
			const result = await response.json();
			if (!response.ok) throw new Error(result.error);
		} catch (removeError) {
			setError(removeError instanceof Error ? removeError.message : String(removeError));
		} finally {
			setBusy(false);
		}
	};
	const canManageAttachments = Boolean(
		connected && state && ["draft", "review", "blocked", "failed"].includes(state.status),
	);

	return (
		<div className="app-shell">
			<PlanHeader
				busy={busy}
				connected={connected}
				hasPlan={hasPlan}
				idle={idle}
				onApprove={() => action("approve")}
				onDiscard={() => setShowDiscardConfirmation(true)}
				onEdit={() => setEditorSelection({ line: 1, text: "" })}
				status={state?.status}
			/>
			<ErrorBanner error={error} />
			<main className="review-layout">
				<PlanSurface
					annotations={annotations}
					busy={busy}
					content={state?.content || ""}
					editorSelection={editorSelection}
					idle={idle}
					onCancelEdit={() => setEditorSelection(null)}
					onSave={async (content) => {
						if (await action("save", content)) setEditorSelection(null);
					}}
					onSelection={setPendingSelection}
					selection={pendingSelection}
				/>
				<ReviewSidebar
					activeTab={sidebarTab}
					annotations={annotations}
					attachments={state?.attachments || []}
					activity={activity}
					busy={busy}
					canManageAttachments={canManageAttachments}
					canSubmit={Boolean(connected && idle)}
					copied={copied}
					onAddGlobal={() => setShowGlobalAnnotation(true)}
					onChangeTab={setSidebarTab}
					onCopy={copyAnnotations}
					onRemove={(id) => setAnnotations((current) => current.filter((annotation) => annotation.id !== id))}
					onRemoveAttachment={removeAttachment}
					onSelect={focusAnnotation}
					onSubmit={submitAnnotations}
					onUploadAttachments={uploadAttachments}
				/>
			</main>
			<PlanOverlays
				busy={busy}
				commentSelection={commentSelection}
				idle={idle}
				onAddGlobal={(comment) => {
					setAnnotations((current) => [...current, { id: crypto.randomUUID(), type: "global", comment }]);
					setSidebarTab("annotations");
					setShowGlobalAnnotation(false);
				}}
				onCancelComment={() => setCommentSelection(null)}
				onCancelDiscard={() => setShowDiscardConfirmation(false)}
				onCancelGlobal={() => setShowGlobalAnnotation(false)}
				onCancelSelection={() => {
					setPendingSelection(null);
					clearNativeSelection();
				}}
				onCommentSelection={() => {
					setCommentSelection(pendingSelection);
					setPendingSelection(null);
				}}
				onConfirmDiscard={async () => {
					if (await action("discard")) setShowDiscardConfirmation(false);
				}}
				onEditSelection={() => {
					setEditorSelection(pendingSelection);
					setPendingSelection(null);
					clearNativeSelection();
				}}
				onSubmitComment={(comment) => addAnnotation(commentSelection, "comment", comment)}
				pendingSelection={pendingSelection}
				showDiscardConfirmation={showDiscardConfirmation}
				showGlobalAnnotation={showGlobalAnnotation}
			/>
		</div>
	);
}

createRoot(document.getElementById("root")).render(<App />);
