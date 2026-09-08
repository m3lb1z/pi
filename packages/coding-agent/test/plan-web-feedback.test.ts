import { describe, expect, it } from "vitest";
import { formatAnnotationFeedback } from "../src/core/plan-web/annotation-feedback.ts";

describe("plan web annotation feedback", () => {
	it("formats comments and deletions for planner revision", () => {
		const feedback = formatAnnotationFeedback([
			{ type: "comment", line: 5, text: "Long implementation detail", comment: "Make this more compact." },
			{ type: "deletion", line: 71, text: "CREATE TABLE documents ();", comment: "" },
		]);

		expect(feedback).toContain("YOUR PLAN WAS NOT APPROVED.");
		expect(feedback).toContain('## 1. (line 5) Feedback on: "Long implementation detail"');
		expect(feedback).toContain("> Make this more compact.");
		expect(feedback).toContain("## 2. (line 71) Remove this\n```\nCREATE TABLE documents ();\n```");
		expect(feedback).toContain("I've reviewed this plan and have 2 pieces of feedback:");
	});

	it("uses a longer fence when deleted text contains backticks", () => {
		const feedback = formatAnnotationFeedback([
			{ type: "deletion", line: 3, text: "Remove ```nested``` content", comment: "" },
		]);

		expect(feedback).toContain("````\nRemove ```nested``` content\n````");
		expect(feedback).toContain("1 piece of feedback");
	});

	it("formats feedback that applies to the full plan", () => {
		const feedback = formatAnnotationFeedback([
			{ type: "global", comment: "Add rollback criteria to every deployment phase." },
		]);

		expect(feedback).toContain("## 1. General feedback");
		expect(feedback).toContain("> Add rollback criteria to every deployment phase.");
		expect(feedback).not.toContain("(line ");
	});
});
