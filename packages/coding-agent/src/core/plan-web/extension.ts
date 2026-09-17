import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { basename, join } from "node:path";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { Api, ImageContent, Model, TextContent } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { CONFIG_DIR_NAME, getAgentDir } from "../../config.ts";
import { PlanModeSelectorComponent } from "../../modes/interactive/components/plan-mode-selector.ts";
import { detectSupportedImageMimeTypeFromFile } from "../../utils/mime.ts";
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
import { resolveReadPath } from "../tools/path-utils.ts";
import { type PlannerTemplate, readPlannerTemplate } from "./planner-templates.ts";
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
const PLAN_EXTENSION_TOOLS = ["ripgrep", ...PLAN_DOCUMENT_TOOLS];
const PLANNER_TOOLS = ["read", ...PLAN_DOCUMENT_TOOLS];
const PLANNER_INSPECTION_TOOLS = ["ripgrep", ...PLANNER_TOOLS];
// CLI @file arguments become <file name="...">; /plan instructions can also name paths directly.
const IMAGE_REFERENCE_PATTERN = /<file name="([^"]+)">|(?:^|\s)@(?:"([^"]+)"|'([^']+)'|([^\s]+))/g;
const ABSOLUTE_IMAGE_PATH_PATTERN =
	/(?:^|\s)(?:"((?:[a-z]:[\\/]|\/|\\\\)[^"]+\.(?:png|jpe?g|gif|webp|bmp))"|((?:[a-z]:[\\/]|\/|\\\\)[^\s"'<>]+\.(?:png|jpe?g|gif|webp|bmp)))/gi;

export interface PlanExtensionOptions {
	directory?: string;
	port?: number;
}

export function getProjectPlanDirectory(directory: string, project: string): string {
	const projectId = createHash("sha256").update(project).digest("hex").slice(0, 16);
	return join(directory, "plans", projectId);
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
	let plannerTemplate: PlannerTemplate | undefined;
	const importedImagePaths = new Map<string, string>();

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
		savedTools ??= pi.getActiveTools().filter((name) => !PLAN_EXTENSION_TOOLS.includes(name));
		mode = next;
		pi.setActiveTools(next === "planner" ? PLANNER_TOOLS : savedTools);
		context?.ui.setStatus(
			"plan-web",
			`${next}${server ? `:${server.state.activePlanner}` : ""} · ${server ? new URL(server.url).host : "localhost:7337"}`,
		);
	}

	function configurePlannerInspection(prompt: string): void {
		inspectionAllowed = /<file name=|(?:^|\s)@[^\s]+/.test(prompt);
		pi.setActiveTools(inspectionAllowed ? PLANNER_INSPECTION_TOOLS : PLANNER_TOOLS);
	}

	function readPlannerSystemPrompt(ctx: ExtensionContext): string | undefined {
		const projectPath = join(ctx.cwd, CONFIG_DIR_NAME, "SYSTEM_PLANNING.md");
		const promptPath =
			ctx.isProjectTrusted() && existsSync(projectPath) ? projectPath : join(directory, "SYSTEM_PLANNING.md");
		return existsSync(promptPath) ? stripBom(readFileSync(promptPath, "utf8")) : undefined;
	}

	async function importInstructionImages(task: string, cwd: string, current: PlanServer): Promise<void> {
		const references = [...task.matchAll(IMAGE_REFERENCE_PATTERN), ...task.matchAll(ABSOLUTE_IMAGE_PATH_PATTERN)];
		for (const match of references) {
			const referencedPath = match[1] ?? match[2] ?? match[3] ?? match[4] ?? match[5] ?? match[6];
			if (!referencedPath) continue;
			const normalizedReference = match[4] ? referencedPath.replace(/[),.;!?]+$/, "") : referencedPath;
			if (match[1] === undefined && !/\.(?:png|jpe?g|gif|webp|bmp)$/i.test(normalizedReference)) continue;
			const absolutePath = realpathSync(resolveReadPath(normalizedReference, cwd));
			const existingId = importedImagePaths.get(absolutePath);
			if (existingId && current.readActiveAttachments().some((attachment) => attachment.id === existingId)) continue;
			if (!(await detectSupportedImageMimeTypeFromFile(absolutePath))) continue;
			const fileStats = await stat(absolutePath);
			if (fileStats.size === 0 || fileStats.size > 20 * 1024 * 1024)
				throw new Error(`Plan image must be between 1 byte and 20 MiB: ${absolutePath}`);
			const attachment = await current.addAttachment(basename(absolutePath), await readFile(absolutePath));
			importedImagePaths.set(absolutePath, attachment.id);
		}
	}

	function attachPlanImages(text: string, current: PlanServer): string | Array<TextContent | ImageContent> {
		const images = current.readAttachmentContent();
		if (images.length === 0) return text;
		const annex = current
			.readActiveAttachments()
			.map((attachment, index) => `${index + 1}. [Image ${index + 1}] ${attachment.name}`)
			.join("\n");
		return [
			{
				type: "text",
				text: `${text}\n\n<plan_attachments>\nThese persistent image annexes belong to the plan. Images follow this text in the listed order.\n${annex}\n</plan_attachments>`,
			},
			...images,
		];
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
					const allPlans = current.readAllPlans();
					const approvedPlans = allPlans.filter((plan) => plan.content.trim());
					const workspaceRevision = current.workspaceRevision(allPlans);
					await selectModel("programming", ctx);
					requireOwner();
					current.assertRevision(request.revision);
					current.assertWorkspaceRevision(workspaceRevision);
					if (server !== current || !ctx.isIdle() || ctx.hasPendingMessages())
						throw new Error("Session changed or Pi became busy. Review again.");
					pi.clearContext();
					activate("programming");
					approvedRevision = workspaceRevision;
					lastAssistantText = "";
					current.update({ status: "executing", activity: "", result: "" });
					pi.sendUserMessage(
						attachPlanImages(
							`Implement the approved planning artifacts below in ${ctx.cwd}. Complete their validation and report the result. If the scope must change, stop and explain why.\n\n${approvedPlans.map((plan) => `## ${plan.name}\n\n${plan.content}`).join("\n\n")}`,
							current,
						),
						{ deliverAs: "followUp" },
					);
				} catch (error) {
					if (server === current && current.state.status === "approving") current.update({ status: "review" });
					if (server === current && mode === "planner") await selectModel("planner", ctx);
					throw error;
				}
			} else if (request.action === "save") {
				current.assertRevision(request.revision);
				const original = current.readActiveContent();
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
				} else {
					approvedRevision = undefined;
					current.write("");
					current.clearAttachments();
					importedImagePaths.clear();
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
		description: "Activate a planning artifact at localhost:7337: /plan [planner]",
		async handler(args, ctx) {
			if (commandPending || actionPending) return;
			commandPending = true;
			let created: PlanServer | undefined;
			try {
				const plannerName = args.trim() || "general";
				if (/\s/.test(plannerName)) throw new Error("/plan accepts only one planner name, for example /plan uml.");
				if (!ctx.isIdle() || ctx.hasPendingMessages())
					throw new Error("Wait for Pi to finish before opening a plan.");
				if (server && ["planning", "approving", "executing"].includes(server.state.status))
					throw new Error("The current plan is still active.");
				const selectedTemplate = readPlannerTemplate(plannerName, ctx, directory);
				context = ctx;
				owner = ctx.sessionManager.getSessionId();
				if (!server) {
					const project = realpathSync(ctx.cwd);
					created = new PlanServer(getProjectPlanDirectory(directory, project), project, plannerName, action);
					await created.start(options.port);
					server = created;
				}
				workflowDefaultModel ??= ctx.model;
				await selectModel("planner", ctx);
				plannerTemplate = selectedTemplate;
				server.activatePlanner(plannerName);
				importedImagePaths.clear();
				activate("planner");
				ctx.ui.notify(`Plan ${plannerName}: ${server.url}`);
			} catch (error) {
				if (created && server === created) await cleanup();
				ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
			} finally {
				commandPending = false;
			}
		},
	});
	pi.on("input", async (event, ctx) => {
		if (!server || mode !== "planner" || event.source === "extension" || ctx.sessionManager.getSessionId() !== owner)
			return;
		try {
			await importInstructionImages(event.text, ctx.cwd, server);
		} catch (error) {
			ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
		}
	});

	const cwd = process.cwd();
	pi.registerTool({ ...createGrepToolDefinition(cwd), name: "ripgrep", label: "ripgrep" });
	pi.registerTool({
		name: "edit_plan",
		label: "Edit active planning artifact",
		description:
			"Revise the nonempty active planning artifact with one or more targeted oldText/newText replacements. Every oldText must identify a unique, non-overlapping region of the original plan. All replacements are validated and applied atomically. Read-only planning artifacts cannot be edited.",
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
			const original = current.readActiveContent();
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
			"Create the first draft of the active planning artifact. For changes to an existing artifact, use edit_plan instead. Read-only planning artifacts cannot be edited.",
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
			if (current.readActiveContent().trim() && !input.replaceExisting)
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
			if (PLAN_EXTENSION_TOOLS.includes(event.toolName)) return { block: true, reason: "Activate /plan first." };
			return;
		}
		if (mode === "programming") {
			try {
				server?.assertWorkspaceRevision(approvedRevision ?? "");
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
		if (!PLANNER_INSPECTION_TOOLS.includes(event.toolName))
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
			if (!plannerTemplate) throw new Error("The active planner template is unavailable.");
			configurePlannerInspection(event.prompt);
			server.refresh();
			return {
				systemPrompt: buildPlannerPrompt(
					{ ...event.systemPromptOptions, cwd: ctx.cwd },
					server.path,
					server.readAllPlans(),
					plannerTemplate,
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
			pi.setActiveTools(PLANNER_TOOLS);
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
		plannerTemplate = undefined;
		importedImagePaths.clear();
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
		pi.setActiveTools(pi.getActiveTools().filter((name) => !PLAN_EXTENSION_TOOLS.includes(name)));
	});
}

export default function planWebExtension(pi: ExtensionAPI): void {
	registerPlanWeb(pi);
}
