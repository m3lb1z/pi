import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { Api, Model } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { CONFIG_DIR_NAME, getAgentDir } from "../../config.ts";
import { PlanModeSelectorComponent } from "../../modes/interactive/components/plan-mode-selector.ts";
import { stripBom } from "../../utils/text.ts";
import { DEFAULT_THINKING_LEVEL, THINKING_LEVEL_OPTIONS } from "../defaults.ts";
import type { ExtensionAPI, ExtensionContext } from "../extensions/types.ts";
import {
	applyEditsToNormalizedContent,
	detectLineEnding,
	normalizeToLF,
	restoreLineEndings,
} from "../tools/edit-diff.ts";
import { createGrepToolDefinition } from "../tools/grep.ts";
import { buildPlannerPrompt } from "./prompts.ts";
import { type PlanAction, PlanServer } from "./server.ts";

type Mode = "planner" | "programming";
interface ModelChoice {
	provider: string;
	id: string;
	thinking: ThinkingLevel;
}
type ModeConfig = Partial<Record<Mode, ModelChoice>>;
const PLAN_DOCUMENT_TOOLS = ["edit_plan", "write_plan"];
const PLANNER_TOOLS = ["ripgrep", ...PLAN_DOCUMENT_TOOLS];

export interface PlanExtensionOptions {
	directory?: string;
	port?: number;
}

export function getProjectPlanPath(directory: string, project: string): string {
	const projectId = createHash("sha256").update(project).digest("hex").slice(0, 16);
	return join(directory, "plans", `${projectId}.md`);
}

function migrateLegacyPlan(directory: string): void {
	const legacyPath = join(directory, "plan_current.md");
	if (!existsSync(legacyPath)) return;
	const firstLine = readFileSync(legacyPath, "utf8").split("\n", 1)[0];
	const prefix = "<!-- pi-plan-project: ";
	if (!firstLine.startsWith(prefix) || !firstLine.endsWith(" -->")) return;
	try {
		const project: unknown = JSON.parse(firstLine.slice(prefix.length, -4));
		if (typeof project !== "string") return;
		const destination = getProjectPlanPath(directory, project);
		if (existsSync(destination)) return;
		mkdirSync(dirname(destination), { recursive: true, mode: 0o700 });
		renameSync(legacyPath, destination);
	} catch {
		// Leave malformed or inaccessible legacy plans untouched.
	}
}

export function registerPlanWeb(pi: ExtensionAPI, options: PlanExtensionOptions = {}): void {
	const directory = options.directory ?? getAgentDir();
	const configPath = join(directory, "plan-models.json");
	let server: PlanServer | undefined;
	let context: ExtensionContext | undefined;
	let owner: string | undefined;
	let mode: Mode | undefined;
	let savedTools: string[] | undefined;
	let commandPending = false;
	let wrotePlan = false;
	let lastError = false;
	let lastAssistantText = "";
	let approvedRevision: string | undefined;
	let actionPending = false;
	let workflowDefaultModel: Model<Api> | undefined;
	let inspectionAllowed = false;

	function readConfig(): ModeConfig {
		try {
			const raw: unknown = JSON.parse(readFileSync(configPath, "utf8"));
			if (!raw || typeof raw !== "object") throw new Error("Invalid plan model configuration.");
			const config: ModeConfig = {};
			for (const key of ["planner", "programming"] as const) {
				const entry: unknown = (raw as Record<string, unknown>)[key];
				if (entry === undefined) continue;
				if (!entry || typeof entry !== "object") throw new Error("Invalid plan model configuration.");
				const { provider, id, thinking: configuredThinking } = entry as Record<string, unknown>;
				if (typeof provider !== "string" || typeof id !== "string")
					throw new Error("Invalid plan model configuration.");
				let thinking = DEFAULT_THINKING_LEVEL;
				if (configuredThinking !== undefined) {
					if (
						typeof configuredThinking !== "string" ||
						!THINKING_LEVEL_OPTIONS.includes(configuredThinking as ThinkingLevel)
					)
						throw new Error("Invalid plan model thinking level.");
					thinking = configuredThinking as ThinkingLevel;
				}
				config[key] = { provider, id, thinking };
			}
			return config;
		} catch (error) {
			if (error instanceof Error && "code" in error && error.code === "ENOENT") return {};
			throw error;
		}
	}

	function writeConfig(config: ModeConfig): void {
		mkdirSync(directory, { recursive: true, mode: 0o700 });
		const temporary = `${configPath}.${process.pid}.tmp`;
		writeFileSync(temporary, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
		renameSync(temporary, configPath);
	}

	function requireOwner(): ExtensionContext {
		if (!context || context.sessionManager.getSessionId() !== owner || !server)
			throw new Error("The original plan session is no longer active. Open /plan again.");
		return context;
	}

	async function selectModel(next: Mode, ctx: ExtensionContext): Promise<void> {
		const choice = readConfig()[next];
		const model = choice ? ctx.modelRegistry.find(choice.provider, choice.id) : (workflowDefaultModel ?? ctx.model);
		if (choice && !model) throw new Error(`Configured ${next} model is unavailable: ${choice.provider}/${choice.id}`);
		if (!model) throw new Error("No default model is available. Select one with /model or configure /mode.");
		if (choice && next === "planner" && !model.reasoning)
			throw new Error("The configured planner model does not support reasoning. Select another with /mode.");
		if (!(await pi.setModel(model))) throw new Error(`No authentication for ${model.provider}. Use /login first.`);
		pi.setThinkingLevel(choice?.thinking ?? DEFAULT_THINKING_LEVEL);
	}

	function activate(next: Mode): void {
		savedTools ??= pi.getActiveTools().filter((name) => !PLANNER_TOOLS.includes(name));
		mode = next;
		pi.setActiveTools(next === "planner" ? PLAN_DOCUMENT_TOOLS : savedTools);
		context?.ui.setStatus("plan-web", `${next} · ${server ? new URL(server.url).host : "localhost:7337"}`);
	}

	function configurePlannerInspection(prompt: string): void {
		inspectionAllowed = /<file name=|(?:^|\s)@[^\s]+/.test(prompt);
		pi.setActiveTools(inspectionAllowed ? PLANNER_TOOLS : PLAN_DOCUMENT_TOOLS);
	}

	function readPlannerSystemPrompt(ctx: ExtensionContext): string | undefined {
		const projectPath = join(ctx.cwd, CONFIG_DIR_NAME, "SYSTEM_PLANNING.md");
		const promptPath =
			ctx.isProjectTrusted() && existsSync(projectPath) ? projectPath : join(directory, "SYSTEM_PLANNING.md");
		return existsSync(promptPath) ? stripBom(readFileSync(promptPath, "utf8")) : undefined;
	}

	function startNewPlan(task: string, ctx: ExtensionContext, current: PlanServer): void {
		approvedRevision = undefined;
		lastAssistantText = "";
		current.update({ status: "planning", result: "", activity: "" });
		current.write("");
		configurePlannerInspection(task);
		pi.sendUserMessage(
			`Create the planning document ${current.path} for this task in ${ctx.cwd}:\n${task.trim()}\n\nThe deliverable is the plan document, not code. Do not explore the repository. Only when the task contains an explicit @file mention may you use the ripgrep tool for a narrow keyword search for a fact missing from the attached content. Save the initial whole draft with write_plan; once the plan has content, use edit_plan with one or more oldText/newText replacements for focused changes. Describe the objective, scope, decisions, steps, validation, and open questions. Verify the resulting text from context and respond with a short summary.`,
			{ deliverAs: "followUp" },
		);
	}

	async function action(request: PlanAction): Promise<void> {
		const ctx = requireOwner();
		const current = server!;
		if (commandPending || !ctx.isIdle() || ctx.hasPendingMessages())
			throw new Error("Pi is busy. Wait for the current turn to finish.");
		actionPending = true;
		try {
			if (request.action === "approve") {
				current.update({ status: "approving" });
				try {
					await selectModel("programming", ctx);
					requireOwner();
					current.assertRevision(request.revision);
					if (server !== current || !ctx.isIdle() || ctx.hasPendingMessages())
						throw new Error("Session changed or Pi became busy. Review again.");
					pi.clearContext();
					activate("programming");
					approvedRevision = request.revision;
					lastAssistantText = "";
					current.update({ status: "executing", activity: "", result: "" });
					pi.sendUserMessage(
						`Implement the approved plan below in ${ctx.cwd}. Complete its validation and report the result. If the scope must change, stop and explain why.\n\n${current.state.content}`,
						{ deliverAs: "followUp" },
					);
				} catch (error) {
					if (server === current && current.state.status === "approving") current.update({ status: "review" });
					if (server === current && mode === "planner") await selectModel("planner", ctx);
					throw error;
				}
			} else if (request.action === "save") {
				current.assertRevision(request.revision);
				const original = current.state.content;
				approvedRevision = undefined;
				activate("planner");
				current.write(restoreLineEndings(request.feedback, detectLineEnding(original)));
				current.update({
					status: request.feedback.trim() ? "review" : "draft",
					activity: "",
					result: "",
				});
			} else {
				await selectModel("planner", ctx);
				requireOwner();
				current.assertRevision(request.revision, request.action === "revise");
				if (server !== current || !ctx.isIdle() || ctx.hasPendingMessages())
					throw new Error("Session changed or Pi became busy.");
				activate("planner");
				if (request.action === "revise") {
					current.update({ status: "planning", result: "", activity: "" });
					configurePlannerInspection(request.feedback);
					pi.sendUserMessage(
						`The current plan is already in context. Apply these observations to it using edit_plan. Change only the affected passages, preserve unrelated text, and verify the resulting plan logically. Do not implement code or repeat the complete plan in the conversation.\n\n${request.feedback}`,
						{ deliverAs: "followUp" },
					);
				} else if (request.action === "new") {
					startNewPlan(request.feedback, ctx, current);
				} else {
					approvedRevision = undefined;
					current.write("");
					current.update({ status: "draft", activity: "", result: "" });
				}
			}
		} finally {
			actionPending = false;
		}
	}

	pi.registerCommand("mode", {
		description: "Configure planner and programming models",
		async handler(args, ctx) {
			try {
				if (actionPending || commandPending || !ctx.isIdle())
					throw new Error("Wait for the current operation before changing models.");
				if (args.trim()) throw new Error("/mode does not accept arguments. Select models from its menu.");
				if (ctx.mode !== "tui") throw new Error("/mode is available in interactive mode.");
				const config = readConfig();
				await ctx.ui.custom<void>(
					(tui, _theme, _keybindings, done) =>
						new PlanModeSelectorComponent(
							tui,
							{
								getAvailableSnapshot: () => ctx.modelRegistry.getAvailable(),
								getError: () => ctx.modelRegistry.getError(),
								getModel: (provider, id) => ctx.modelRegistry.find(provider, id),
								refresh: (refreshOptions) => ctx.modelRegistry.refresh(refreshOptions),
							},
							ctx.scopedModels,
							config,
							(next, choice) => {
								if (choice) config[next] = choice;
								else delete config[next];
								writeConfig(config);
							},
							() => done(),
						),
				);
			} catch (error) {
				ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
			}
		},
	});

	pi.registerCommand("plan", {
		description: "Plan a task and approve it at localhost:7337: /plan [task]",
		async handler(args, ctx) {
			if (commandPending || actionPending) return;
			commandPending = true;
			let created: PlanServer | undefined;
			try {
				if (!ctx.isIdle() || ctx.hasPendingMessages())
					throw new Error("Wait for Pi to finish before opening a plan.");
				if (args.trim() && server && ["planning", "approving", "executing"].includes(server.state.status))
					throw new Error("The current plan is still active.");
				context = ctx;
				owner = ctx.sessionManager.getSessionId();
				if (!server) {
					const project = realpathSync(ctx.cwd);
					migrateLegacyPlan(directory);
					created = new PlanServer(getProjectPlanPath(directory, project), project, action);
					await created.start(options.port, Boolean(args.trim()));
					server = created;
				}
				if (args.trim()) {
					workflowDefaultModel = ctx.model;
					await selectModel("planner", ctx);
					activate("planner");
					startNewPlan(args, ctx, server);
				} else if (!mode || server.state.status === "completed") {
					const shouldResetPlan = server.state.status === "completed";
					workflowDefaultModel ??= ctx.model;
					await selectModel("planner", ctx);
					activate("planner");
					if (shouldResetPlan) {
						approvedRevision = undefined;
						server.write("");
						server.update({ status: "draft", activity: "", result: "" });
					} else if (server.state.content.trim()) {
						server.update({ status: "review" });
					}
				}
				ctx.ui.notify(`Plan: ${server.url}`);
			} catch (error) {
				if (created && server === created) await cleanup();
				ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
			} finally {
				commandPending = false;
			}
		},
	});

	const cwd = process.cwd();
	pi.registerTool({ ...createGrepToolDefinition(cwd), name: "ripgrep", label: "ripgrep" });
	pi.registerTool({
		name: "edit_plan",
		label: "Edit plan_current.md",
		description:
			"Revise a nonempty plan_current.md with one or more targeted oldText/newText replacements. Every oldText must identify a unique, non-overlapping region of the original plan. All replacements are validated and applied atomically. This edits a planning document, never source code.",
		parameters: Type.Object({
			edits: Type.Array(
				Type.Object({
					oldText: Type.String({
						description: "Existing plan text for one targeted replacement. It must be unique in the plan.",
					}),
					newText: Type.String({ description: "Replacement text for this targeted edit." }),
				}),
				{
					minItems: 1,
					description:
						"One or more non-overlapping replacements. Every oldText is matched against the original plan, not against the result of an earlier edit.",
				},
			),
		}),
		async execute(_id, input, signal) {
			requireOwner();
			if (signal?.aborted || mode !== "planner" || server?.state.status !== "planning")
				throw new Error("Plan editing requires active planner mode.");
			const current = server;
			current.refresh();
			const original = current.state.content;
			if (!original.trim()) throw new Error("The plan is empty. Create the whole document with write_plan first.");
			const { newContent } = applyEditsToNormalizedContent(normalizeToLF(original), input.edits, current.path);
			current.write(restoreLineEndings(newContent, detectLineEnding(original)));
			wrotePlan = true;
			return {
				content: [
					{
						type: "text",
						text: `Applied ${input.edits.length} targeted edit(s) to ${current.path}. Unrelated text was preserved.`,
					},
				],
				details: undefined,
			};
		},
	});
	pi.registerTool({
		name: "write_plan",
		label: "Write current plan",
		description:
			"Create the first draft of plan_current.md. For changes to an existing plan, use edit_plan instead. Replacing a nonempty plan requires replaceExisting and an explicit user request for a complete rewrite.",
		parameters: Type.Object({
			content: Type.String({ minLength: 1 }),
			replaceExisting: Type.Optional(Type.Boolean()),
		}),
		async execute(_id, input, signal) {
			requireOwner();
			if (signal?.aborted || mode !== "planner" || server?.state.status !== "planning")
				throw new Error("Plan writing requires active planner mode.");
			const current = server;
			current.refresh();
			if (current.state.content.trim() && !input.replaceExisting)
				throw new Error(
					"The plan already exists in context. Use edit_plan for targeted changes. Do not transcribe the entire plan.",
				);
			current.write(input.content);
			wrotePlan = true;
			return {
				content: [
					{ type: "text", text: `Saved ${current.path}. Browser approval is required before implementation.` },
				],
				details: undefined,
			};
		},
	});
	pi.on("tool_call", (event) => {
		if (!mode) {
			if (PLANNER_TOOLS.includes(event.toolName)) return { block: true, reason: "Activate /plan first." };
			return;
		}
		if (mode === "programming") {
			try {
				server?.assertRevision(approvedRevision ?? "");
			} catch {
				return {
					block: true,
					reason: "The approved plan changed. Request a revision in the browser before continuing.",
				};
			}
			return;
		}
		if (event.toolName === "ripgrep") {
			if (!inspectionAllowed) {
				return {
					block: true,
					reason: "Repository inspection requires an explicit @file mention in the current request.",
				};
			}
			event.input.limit = 20;
			event.input.context = 0;
			event.input.literal = true;
		}
		if (!PLANNER_TOOLS.includes(event.toolName))
			return { block: true, reason: "This tool is unavailable in the current plan mode." };
	});
	pi.on("user_bash", () => {
		if (mode === "planner")
			return {
				result: {
					output: "Shell commands are unavailable in planner mode.",
					exitCode: 1,
					cancelled: false,
					truncated: false,
				},
			};
	});
	pi.on("before_agent_start", (event, ctx) => {
		if (!mode || !server) return;
		context = ctx;
		lastError = false;
		wrotePlan = false;
		lastAssistantText = "";
		server.update({ status: mode === "planner" ? "planning" : "executing", activity: "", result: "" });
		if (mode === "planner") {
			inspectionAllowed =
				/<file name=|(?:^|\s)@[^\s]+/.test(event.prompt) && pi.getActiveTools().includes("ripgrep");
			server.refresh();
			return {
				systemPrompt: buildPlannerPrompt(
					{ ...event.systemPromptOptions, cwd: ctx.cwd },
					server.path,
					server.state.content,
					inspectionAllowed,
					readPlannerSystemPrompt(ctx),
				),
			};
		}
	});
	pi.on("message_update", (event) => {
		if (!server || !mode || event.message.role !== "assistant") return;
		const text = event.message.content
			.filter((part) => part.type === "text")
			.map((part) => part.text)
			.join("\n");
		lastAssistantText = text;
		server.update({ activity: text.slice(-20000) });
	});
	pi.on("message_end", (event) => {
		if (event.message.role === "assistant") {
			lastError = event.message.stopReason === "error" || event.message.stopReason === "aborted";
			lastAssistantText = event.message.content
				.filter((part) => part.type === "text")
				.map((part) => part.text)
				.join("\n");
		}
	});
	pi.on("agent_settled", () => {
		if (!server || !mode) return;
		if (mode === "planner") {
			server.update({ status: lastError ? "blocked" : wrotePlan ? "review" : "draft" });
			inspectionAllowed = false;
			pi.setActiveTools(PLAN_DOCUMENT_TOOLS);
		} else
			server.update(
				lastError
					? { status: "blocked", result: "Execution interrupted. Review the terminal before continuing." }
					: { status: "completed", result: lastAssistantText || "Implementation completed." },
			);
	});
	async function cleanup(): Promise<void> {
		const current = server;
		server = undefined;
		mode = undefined;
		owner = undefined;
		approvedRevision = undefined;
		inspectionAllowed = false;
		workflowDefaultModel = undefined;
		if (savedTools) pi.setActiveTools(savedTools);
		savedTools = undefined;
		context?.ui.setStatus("plan-web", undefined);
		context = undefined;
		if (current) await current.close();
	}
	pi.on("session_shutdown", cleanup);
	pi.on("session_start", async () => {
		await cleanup();
		pi.setActiveTools(pi.getActiveTools().filter((name) => !PLANNER_TOOLS.includes(name)));
	});
}

export default function planWebExtension(pi: ExtensionAPI): void {
	registerPlanWeb(pi);
}
