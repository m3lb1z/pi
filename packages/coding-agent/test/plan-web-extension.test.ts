import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Api, Model } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
	RegisteredCommand,
} from "../src/core/extensions/types.ts";
import { registerPlanWeb } from "../src/core/plan-web/extension.ts";
import type { PlanState } from "../src/core/plan-web/server.ts";
import { builtInExtensions } from "../src/extensions/index.ts";

type Handler = (event: unknown, ctx: ExtensionContext) => unknown;
interface CapturedTool {
	name: string;
	execute: (
		id: string,
		args: unknown,
		signal: AbortSignal | undefined,
		update: undefined,
		ctx: ExtensionContext,
	) => Promise<unknown>;
}
const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
	for (const close of cleanup.splice(0)) await close();
	vi.restoreAllMocks();
});

async function setup(
	options: {
		configured?: boolean | "planner";
		defaultModel?: "reasoner" | "fast";
		openBrowser?: boolean;
		projectTrusted?: boolean;
	} = {},
) {
	const directory = mkdtempSync(join(tmpdir(), "pi-plan-extension-"));
	if (options.configured !== false) {
		const configDirectory = join(directory, ".pi");
		mkdirSync(configDirectory, { recursive: true });
		const config = {
			planner: { provider: "test", id: "reasoner" },
			...(options.configured === "planner" ? {} : { programming: { provider: "test", id: "fast" } }),
		};
		writeFileSync(join(configDirectory, "plan-models.json"), JSON.stringify(config));
	}
	let activeTools = ["read", "bash", "edit", "write", "custom_tool"];
	const commands = new Map<string, RegisteredCommand["handler"]>();
	const events = new Map<string, Handler>();
	const tools = new Map<string, CapturedTool>();
	const notify = vi.fn();
	const sendUserMessage = vi.fn();
	const model = (id: string): Model<Api> => ({
		id,
		provider: "test",
		name: id,
		api: "openai-completions",
		baseUrl: "http://unused.invalid",
		reasoning: id === "reasoner",
		input: ["text"],
		contextWindow: 10000,
		maxTokens: 1000,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	});
	const setModel = vi.fn(async (_model: Model<Api>) => true);
	const setThinkingLevel = vi.fn();
	const exec = vi.fn(async () => ({ code: 0, stdout: "", stderr: "" }));
	const ctx = {
		cwd: directory,
		mode: "tui",
		model: model(options.defaultModel ?? "reasoner"),
		scopedModels: [],
		sessionManager: { getSessionId: () => "owner" },
		modelRegistry: {
			find: (provider: string, id: string) =>
				provider === "test" && ["reasoner", "fast"].includes(id) ? model(id) : undefined,
			getAvailable: () => [model("reasoner"), model("fast")],
			getError: () => undefined,
			refresh: vi.fn(async () => ({ aborted: false, errors: new Map() })),
		},
		isIdle: vi.fn(() => true),
		hasPendingMessages: () => false,
		isProjectTrusted: () => options.projectTrusted !== false,
		ui: { notify, setStatus: vi.fn(), custom: vi.fn() },
	} as unknown as ExtensionCommandContext;
	const api = {
		registerCommand(name: string, command: { handler: RegisteredCommand["handler"] }) {
			commands.set(name, command.handler);
		},
		registerTool(tool: CapturedTool) {
			tools.set(tool.name, tool);
		},
		on(name: string, handler: Handler) {
			events.set(name, handler);
		},
		getActiveTools: () => activeTools,
		setActiveTools: (names: string[]) => {
			activeTools = names;
		},
		setModel,
		setThinkingLevel,
		sendUserMessage,
		exec,
	} as unknown as ExtensionAPI;
	registerPlanWeb(api, { directory: join(directory, ".pi"), port: 0, openBrowser: options.openBrowser ?? false });
	const emit = async (name: string, event: unknown = {}) => events.get(name)?.(event, ctx);
	cleanup.push(async () => {
		await emit("session_shutdown");
		rmSync(directory, { recursive: true, force: true });
	});
	const command = async (name: string, args = "") => commands.get(name)!(args, ctx);
	const getUrl = () =>
		new URL(
			notify.mock.calls
				.map((call) => String(call[0]))
				.reverse()
				.find((message) => message.startsWith("Plan: "))!
				.slice(6),
		);
	async function state(): Promise<PlanState> {
		const url = getUrl();
		const abort = new AbortController();
		try {
			const response = await fetch(`${url.origin}/events?token=${url.hash.slice(1)}`, { signal: abort.signal });
			const data = await response.body!.getReader().read();
			return JSON.parse(new TextDecoder().decode(data.value).slice(6)) as PlanState;
		} finally {
			abort.abort();
		}
	}
	async function action(action = "approve", feedback = "") {
		const url = getUrl();
		return fetch(`${url.origin}/action`, {
			method: "POST",
			headers: { "Content-Type": "application/json", Origin: url.origin, "X-Plan-Token": url.hash.slice(1) },
			body: JSON.stringify({ action, revision: (await state()).revision, feedback }),
		});
	}
	const execute = (name: string, args: unknown) => tools.get(name)!.execute("call", args, undefined, undefined, ctx);
	async function plan() {
		await command("plan", "Add validation");
		await emit("before_agent_start", { systemPrompt: "Base instructions" });
		await execute("write_plan", { content: "# Plan\n\n1. Add validation\n2. Run checks" });
		await emit("agent_settled");
	}
	return {
		directory,
		ctx,
		command,
		emit,
		execute,
		plan,
		action,
		state,
		notify,
		setModel,
		setThinkingLevel,
		sendUserMessage,
		exec,
		activeTools: () => activeTools,
	};
}

describe("plan web extension", () => {
	it("is registered as a bundled internal extension", () => {
		expect(builtInExtensions).toContainEqual(
			expect.objectContaining({ name: "plan-web", factory: expect.any(Function), hidden: true }),
		);
	});

	it("opens the authenticated plan URL when plan mode starts", async () => {
		const test = await setup({ openBrowser: true });
		await test.command("plan");
		const opener = process.platform === "darwin" ? "open" : process.platform === "win32" ? "rundll32" : "xdg-open";
		expect(test.exec).toHaveBeenCalledWith(
			opener,
			expect.arrayContaining([expect.stringMatching(/^http:\/\/localhost:\d+\/#.+/)]),
			{
				timeout: 5000,
			},
		);
	});

	it("uses the session default model for each mode without explicit configuration", async () => {
		const test = await setup({ configured: false });
		await test.plan();
		expect(test.setModel).toHaveBeenLastCalledWith(expect.objectContaining({ id: "reasoner" }));
		await test.action();
		expect(test.setModel).toHaveBeenLastCalledWith(expect.objectContaining({ id: "reasoner" }));
	});

	it("uses the session default only for the mode without configuration", async () => {
		const test = await setup({ configured: "planner", defaultModel: "fast" });
		await test.plan();
		expect(test.setModel).toHaveBeenLastCalledWith(expect.objectContaining({ id: "reasoner" }));
		await test.action();
		expect(test.setModel).toHaveBeenLastCalledWith(expect.objectContaining({ id: "fast" }));
	});

	it("switches to the fast model and restores normal Pi tools after browser approval", async () => {
		const test = await setup();
		await test.plan();
		expect(test.setModel).toHaveBeenLastCalledWith(expect.objectContaining({ id: "reasoner" }));
		expect(test.setThinkingLevel).toHaveBeenLastCalledWith("high");
		expect(test.activeTools()).toContain("write_plan");
		expect(test.activeTools()).not.toContain("bash");
		expect((await test.state()).status).toBe("review");
		expect((await test.action()).status).toBe(200);
		expect(test.setModel).toHaveBeenLastCalledWith(expect.objectContaining({ id: "fast" }));
		expect(test.setThinkingLevel).toHaveBeenLastCalledWith("off");
		expect(test.activeTools()).toEqual(["read", "bash", "edit", "write", "custom_tool"]);
		expect(test.sendUserMessage).toHaveBeenLastCalledWith(expect.stringContaining("Implement the approved plan"), {
			deliverAs: "followUp",
		});
		expect(test.sendUserMessage).toHaveBeenLastCalledWith(expect.stringContaining("1. Add validation"), {
			deliverAs: "followUp",
		});
		expect((await test.action()).status).toBe(409);
		expect(await test.emit("before_agent_start", { systemPrompt: "Base" })).toBeUndefined();
		await test.emit("message_end", {
			message: {
				role: "assistant",
				stopReason: "stop",
				content: [{ type: "text", text: "Validation added. Checks passed." }],
			},
		});
		await test.emit("agent_settled");
		expect((await test.state()).status).toBe("completed");
		expect((await test.state()).result).toBe("Validation added. Checks passed.");

		await test.command("plan");
		expect(await test.state()).toMatchObject({ status: "draft", content: "", activity: "", result: "" });
		expect(test.activeTools()).toContain("write_plan");
		expect(test.activeTools()).not.toContain("bash");
		expect(test.setModel).toHaveBeenLastCalledWith(expect.objectContaining({ id: "reasoner" }));
	});

	it("returns browser observations to the planner without executing the plan", async () => {
		const test = await setup();
		await test.plan();
		expect((await test.action("revise", "Include edge cases")).status).toBe(200);
		expect(test.sendUserMessage).toHaveBeenLastCalledWith(expect.stringContaining("Include edge cases"), {
			deliverAs: "followUp",
		});
		expect((await test.state()).status).toBe("planning");
		expect(test.activeTools()).not.toContain("bash");
	});

	it("discards the current plan and starts a new task from the browser", async () => {
		const test = await setup();
		await test.plan();
		expect((await test.action("discard")).status).toBe(200);
		expect(await test.state()).toMatchObject({ status: "draft", content: "", activity: "", result: "" });
		expect(test.activeTools()).toContain("write_plan");
		expect(test.sendUserMessage).toHaveBeenCalledTimes(1);

		expect((await test.action("new", "Create a separate feature")).status).toBe(200);
		expect(await test.state()).toMatchObject({ status: "planning", content: "" });
		expect(test.sendUserMessage).toHaveBeenLastCalledWith(expect.stringContaining("Create a separate feature"), {
			deliverAs: "followUp",
		});
	});

	it("blocks normal tools only while planning and detects changes to the approved plan", async () => {
		const test = await setup();
		await test.plan();
		for (const toolName of ["bash", "write", "edit", "custom_tool"]) {
			expect(await test.emit("tool_call", { toolName })).toMatchObject({ block: true });
		}
		await test.action();
		for (const toolName of ["bash", "write", "edit", "custom_tool"]) {
			expect(await test.emit("tool_call", { toolName })).toBeUndefined();
		}
		const path = join(test.directory, ".pi/plan_current.md");
		writeFileSync(path, `${readFileSync(path, "utf8")}\nChanged`);
		expect(await test.emit("tool_call", { toolName: "write" })).toMatchObject({ block: true });
	});

	it("reports an interrupted programming run as blocked", async () => {
		const test = await setup();
		await test.plan();
		await test.action();
		await test.emit("before_agent_start", { systemPrompt: "Base" });
		await test.emit("message_end", { message: { role: "assistant", stopReason: "aborted", content: [] } });
		await test.emit("agent_settled");
		expect((await test.state()).status).toBe("blocked");
	});

	it("restores tools and closes the old browser endpoint when switching sessions", async () => {
		const test = await setup();
		await test.plan();
		await test.emit("session_start");
		expect(test.activeTools()).toEqual(["read", "bash", "edit", "write", "custom_tool"]);
		await expect(test.action()).rejects.toThrow();
		await test.command("plan");
		expect(test.sendUserMessage).toHaveBeenCalledTimes(1);
		expect(test.activeTools()).toContain("write_plan");
	});

	it("applies exact plan diff blocks sequentially and rejects an implicit whole-document rewrite", async () => {
		const test = await setup();
		await test.plan();
		await test.action("revise", "Clarify validation");
		await test.emit("before_agent_start", { systemPrompt: "Base" });
		const path = join(test.directory, ".pi/plan_current.md");
		const original = readFileSync(path, "utf8");
		await expect(test.execute("write_plan", { content: "Replacement" })).rejects.toThrow("edit_plan");
		await test.execute("edit_plan", {
			diff: `${"<<<<<<< SEARCH"}
2. Run checks
${"======="}
2. Check invalid values
${">>>>>>> REPLACE"}
${"<<<<<<< SEARCH"}
2. Check invalid values
${"======="}
2. Check empty input and invalid values
${">>>>>>> REPLACE"}`,
		});
		expect(readFileSync(path, "utf8")).toBe(
			original.replace("2. Run checks", "2. Check empty input and invalid values"),
		);
		await test.emit("agent_settled");
		expect((await test.state()).status).toBe("review");
		expect(test.activeTools()).toContain("edit_plan");
	});

	it("rejects a non-unique or stale plan diff atomically", async () => {
		const test = await setup();
		await test.plan();
		await test.action("revise", "Clarify validation");
		await test.emit("before_agent_start", { systemPrompt: "Base" });
		const path = join(test.directory, ".pi/plan_current.md");
		const original = readFileSync(path, "utf8");
		await expect(
			test.execute("edit_plan", {
				diff: `${"<<<<<<< SEARCH"}
i
${"======="}
x
${">>>>>>> REPLACE"}`,
			}),
		).rejects.toThrow("matched 2 times");
		expect(readFileSync(path, "utf8")).toBe(original);
		await expect(
			test.execute("edit_plan", {
				diff: `${"<<<<<<< SEARCH"}
1. Add validation
${"======="}
1. Validate all inputs
${">>>>>>> REPLACE"}
${"<<<<<<< SEARCH"}
missing text
${"======="}
replacement
${">>>>>>> REPLACE"}`,
			}),
		).rejects.toThrow("matched 0 times");
		expect(readFileSync(path, "utf8")).toBe(original);
	});

	it("uses a document-editor system prompt and preserves project instructions", async () => {
		const test = await setup();
		await test.command("plan", "Implement validation");
		const result = (await test.emit("before_agent_start", {
			systemPrompt: "You are an expert coding assistant. Generate implementation files.",
			systemPromptOptions: {
				cwd: test.directory,
				contextFiles: [{ path: "AGENTS.md", content: "Preserve the public API." }],
			},
		})) as { systemPrompt: string };
		expect(result.systemPrompt).toContain("You are a planning document editor");
		expect(result.systemPrompt).toContain("DIFF mode applies once the plan has content");
		expect(result.systemPrompt).toContain("Preserve the public API.");
		expect(result.systemPrompt).toContain("Default to zero repository searches");
		expect(result.systemPrompt).toContain("This request contains no explicit file mention");
		expect(result.systemPrompt).not.toContain("plan_read");
		expect(result.systemPrompt).not.toContain("plan_find");
		expect(result.systemPrompt).not.toContain("plan_ls");
		expect(result.systemPrompt).not.toContain("You are an expert coding assistant");
		expect(result.systemPrompt).not.toContain("Generate implementation files.");
		expect(await test.emit("tool_call", { toolName: "ripgrep", input: { pattern: "validation" } })).toMatchObject({
			block: true,
		});
		expect(test.sendUserMessage).toHaveBeenLastCalledWith(
			expect.stringContaining("The deliverable is the plan document, not code"),
			{ deliverAs: "followUp" },
		);
	});

	it("adds SYSTEM_PLANNING.md only to the planner system prompt", async () => {
		const test = await setup();
		writeFileSync(join(test.directory, ".pi/SYSTEM_PLANNING.md"), "Prefer risk-first plans.");
		await test.command("plan", "Implement validation");
		const result = (await test.emit("before_agent_start", {
			prompt: "Implement validation",
			systemPrompt: "Programming SYSTEM.md instructions",
			systemPromptOptions: { cwd: test.directory, customPrompt: "Programming SYSTEM.md instructions" },
		})) as { systemPrompt: string };
		expect(result.systemPrompt).toContain("Prefer risk-first plans.");
		expect(result.systemPrompt).toContain("WHOLE/DIFF editing protocol");
		expect(result.systemPrompt).not.toContain("Programming SYSTEM.md instructions");
	});

	it("keeps the current plan in context without reading it from disk", async () => {
		const test = await setup();
		await test.plan();
		const result = (await test.emit("before_agent_start", {
			prompt: "Clarify validation without inspecting files",
			systemPrompt: "Base",
			systemPromptOptions: { cwd: test.directory },
		})) as { systemPrompt: string };
		expect(result.systemPrompt).toContain("# Plan\n\n1. Add validation\n2. Run checks");
		expect(result.systemPrompt).toContain("Never call a file tool to read");
	});

	it("allows one narrow literal ripgrep search when the request mentions a file", async () => {
		const test = await setup();
		await test.command("plan", "Review @src/validation.ts");
		const result = (await test.emit("before_agent_start", {
			prompt: "Review @src/validation.ts",
			systemPrompt: "Base",
			systemPromptOptions: { cwd: test.directory },
		})) as { systemPrompt: string };
		expect(result.systemPrompt).toContain("This request contains an explicit file mention");
		expect(test.activeTools()).toContain("ripgrep");
		const event = { toolName: "ripgrep", input: { pattern: "validate|parse", limit: 100, context: 10 } };
		expect(await test.emit("tool_call", event)).toBeUndefined();
		expect(event.input).toMatchObject({ pattern: "validate|parse", limit: 20, context: 0, literal: true });
	});
});
