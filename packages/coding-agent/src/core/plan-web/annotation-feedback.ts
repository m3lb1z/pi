export type PlanAnnotationFeedback =
	| { type: "comment"; line: number; text: string; comment: string }
	| { type: "deletion"; line: number; text: string; comment: string }
	| { type: "global"; comment: string };

export function formatAnnotationFeedback(annotations: PlanAnnotationFeedback[]): string {
	const count = annotations.length;
	const sections = annotations.map((annotation, index) => {
		if (annotation.type === "global") {
			return `## ${index + 1}. General feedback\n> ${annotation.comment}`;
		}
		if (annotation.type === "deletion") {
			const longestFence = Math.max(2, ...Array.from(annotation.text.matchAll(/`+/g), (match) => match[0].length));
			const fence = "`".repeat(longestFence + 1);
			return `## ${index + 1}. (line ${annotation.line}) Remove this\n${fence}\n${annotation.text}\n${fence}\n> Remove this from the plan.`;
		}
		return `## ${index + 1}. (line ${annotation.line}) Feedback on: "${annotation.text}"\n> ${annotation.comment}`;
	});
	return `YOUR PLAN WAS NOT APPROVED.\n\nYou MUST revise the plan to address ALL of the feedback below before calling ExitPlanMode again.\n\nRules:\n- Do not resubmit the same plan unchanged.\n- Do NOT change the plan title (first # heading) unless the user explicitly asks you to.\n\n# Plan Feedback\n\nI've reviewed this plan and have ${count} ${count === 1 ? "piece" : "pieces"} of feedback:\n\n${sections.join("\n\n")}\n\n---`;
}
