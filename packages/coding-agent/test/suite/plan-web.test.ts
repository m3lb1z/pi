import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { expect, it } from "vitest";
import { registerPlanWeb } from "../../src/core/plan-web/extension.ts";
import { createHarness } from "./harness.ts";

it("runs planning and focused document edits through the real session with the faux provider", async () => {
	const directory = mkdtempSync(join(tmpdir(), "pi-plan-session-"));
	const harness = await createHarness({
		models: [
			{ id: "planner", reasoning: true },
			{ id: "programmer", reasoning: false },
		],
		extensionFactories: [(pi) => registerPlanWeb(pi, { directory, port: 0, openBrowser: false })],
	});
	try {
		await harness.session.bindExtensions({ shutdownHandler: () => {} });
		const plan = "# Plan\n\n## Objective\nValidate input.\n\n## Steps\n1. Inspect validation.\n2. Add checks.\n";
		let systemPrompt = "";
		let activeTools: string[] = [];
		harness.setResponses([
			(context) => {
				systemPrompt = context.systemPrompt ?? "";
				activeTools = context.tools?.map((tool) => tool.name) ?? [];
				return fauxAssistantMessage([fauxToolCall("write_plan", { content: plan })], { stopReason: "toolUse" });
			},
			fauxAssistantMessage("Plan saved for review."),
		]);
		await harness.session.prompt("/plan Implement validation");
		await harness.session.waitForIdle();
		expect(systemPrompt).toContain("You are a planning document editor");
		expect(systemPrompt).not.toContain("You are an expert coding assistant");
		expect(activeTools).toContain("edit_plan");
		expect(activeTools).not.toContain("ripgrep");
		expect(activeTools).not.toContain("plan_read");
		expect(activeTools).not.toContain("plan_find");
		expect(activeTools).not.toContain("plan_ls");
		expect(activeTools).not.toContain("plan_write");
		expect(activeTools).not.toContain("bash");
		const path = join(directory, "plan_current.md");
		const original = readFileSync(path, "utf8");
		expect(original).toContain(plan);
		harness.setResponses([
			fauxAssistantMessage(
				[
					fauxToolCall("edit_plan", {
						diff: `${"<<<<<<< SEARCH"}
2. Add checks.
${"======="}
2. Check missing and malformed input.
${">>>>>>> REPLACE"}`,
					}),
				],
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage("Updated the validation step."),
		]);
		await harness.session.prompt("Clarify the second step in the plan.");
		await harness.session.waitForIdle();
		expect(readFileSync(path, "utf8")).toBe(
			original.replace("2. Add checks.", "2. Check missing and malformed input."),
		);
		expect(harness.session.model?.id).toBe("planner");
		expect(harness.session.messages.filter((message) => message.role === "toolResult" && message.isError)).toEqual(
			[],
		);
	} finally {
		await harness.session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
		harness.cleanup();
		rmSync(directory, { recursive: true, force: true });
	}
});
