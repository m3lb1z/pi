import { createHash, randomBytes } from "node:crypto";
import {
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	renameSync,
	rmSync,
	unwatchFile,
	watchFile,
	writeFileSync,
} from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { dirname, join } from "node:path";
import { getPlanWebAssetsDir } from "../../config.ts";
import { processImage } from "../../utils/image-process.ts";
import { detectSupportedImageMimeType } from "../../utils/mime.ts";
import { openBrowser } from "../../utils/open-browser.ts";
import { planPage } from "./page.ts";

export type PlanStatus =
	| "draft"
	| "planning"
	| "review"
	| "approving"
	| "executing"
	| "completed"
	| "blocked"
	| "failed";
export interface PlanState {
	project: string;
	planners: PlanSummary[];
	activePlanner: string;
	viewedPlanner: string;
	content: string;
	revision: string;
	attachments: PlanAttachment[];
	status: PlanStatus;
	activity: string;
	result: string;
}
export interface PlanSummary {
	name: string;
	hasContent: boolean;
}
export interface PlanAttachment {
	id: string;
	name: string;
	mimeType: string;
	size: number;
}
export interface PlanAction {
	action: "approve" | "revise" | "save" | "discard";
	revision: string;
	feedback: string;
}

const MAX_PLAN_BYTES = 1024 * 1024;
const MAX_ACTION_BYTES = MAX_PLAN_BYTES * 6 + 64 * 1024;
const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024;
const MAX_ATTACHMENT_TOTAL_BYTES = 50 * 1024 * 1024;
const MAX_ATTACHMENTS = 20;
const ATTACHMENT_ID_PATTERN = /^[a-f0-9]{24}$/;
const PLANNER_NAME_PATTERN = /^[a-z][a-z0-9-]{0,63}$/;
const SUPPORTED_IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);

/** One listening process owns a project plan. Approval always rechecks the disk revision. */
export class PlanServer {
	readonly token = randomBytes(8).toString("hex");
	readonly state: PlanState;
	private readonly directory: string;
	private server: Server;
	private clients = new Set<ServerResponse>();
	private watchedPaths = new Set<string>();
	private actionPending = false;
	private port = 7337;
	private watching = false;
	private closed = false;
	private onAction: (action: PlanAction) => Promise<void>;

	constructor(
		directory: string,
		project: string,
		initialPlanner: string,
		onAction: (action: PlanAction) => Promise<void>,
	) {
		if (!PLANNER_NAME_PATTERN.test(initialPlanner)) throw new Error(`Invalid planner name: ${initialPlanner}`);
		this.directory = directory;
		this.onAction = onAction;
		this.state = {
			project,
			planners: [],
			activePlanner: initialPlanner,
			viewedPlanner: initialPlanner,
			content: "",
			revision: "",
			attachments: [],
			status: "draft",
			activity: "",
			result: "",
		};
		this.server = createServer((request, response) => {
			void this.handle(request, response).catch((error: unknown) => {
				if (!response.headersSent) response.writeHead(409, { "Content-Type": "application/json" });
				response.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }));
			});
		});
	}

	get url(): string {
		return `http://localhost:${this.port}/#${this.token}`;
	}

	get path(): string {
		return this.plannerPath(this.state.activePlanner);
	}

	private plannerPath(name: string): string {
		if (!PLANNER_NAME_PATTERN.test(name)) throw new Error(`Invalid planner name: ${name}`);
		return join(this.directory, `${name}.md`);
	}

	private attachmentDirectory(name = this.state.activePlanner): string {
		return `${this.plannerPath(name)}.attachments`;
	}

	private attachmentManifestPath(name = this.state.activePlanner): string {
		return `${this.plannerPath(name)}.attachments.json`;
	}

	async start(port?: number): Promise<void> {
		const listen = async (candidate: number): Promise<void> => {
			await new Promise<void>((resolve, reject) => {
				const cleanup = (): void => {
					this.server.removeListener("error", onError);
					this.server.removeListener("listening", onListening);
				};
				const onError = (error: Error): void => {
					cleanup();
					reject(error);
				};
				const onListening = (): void => {
					cleanup();
					resolve();
				};
				this.server.once("error", onError);
				this.server.once("listening", onListening);
				this.server.listen(candidate, "127.0.0.1");
			});
		};
		try {
			await listen(port ?? 7337);
		} catch (error) {
			if (port !== undefined || !(error instanceof Error && "code" in error && error.code === "EADDRINUSE"))
				throw error;
			await listen(0);
		}
		const address = this.server.address();
		if (address && typeof address !== "string") this.port = address.port;
		try {
			mkdirSync(this.directory, { recursive: true, mode: 0o700 });
			if (!existsSync(this.path)) this.write("");
			else this.refresh();
			this.refreshPlanners();
			this.watching = true;
		} catch (error) {
			await this.close();
			throw error;
		}
		openBrowser(this.url);
	}

	private fileChanged = (): void => {
		try {
			this.refreshPlanners();
			this.refreshViewed();
		} catch (error) {
			this.update({ status: "blocked", result: String(error) });
		}
	};

	refresh(): void {
		const active = this.readPlanner(this.state.activePlanner);
		if (this.state.viewedPlanner === this.state.activePlanner) this.applyViewed(active);
	}

	private readPlanner(name: string): { content: string; revision: string; attachments: PlanAttachment[] } {
		const path = this.plannerPath(name);
		const raw = existsSync(path) ? readFileSync(path, "utf8") : "";
		if (Buffer.byteLength(raw) > MAX_PLAN_BYTES) throw new Error("Plan exceeds 1 MiB.");
		const manifestPath = this.attachmentManifestPath(name);
		const manifest = existsSync(manifestPath) ? readFileSync(manifestPath, "utf8") : "";
		const attachments = this.parseAttachmentManifest(manifest);
		const revision = createHash("sha256").update(raw).update("\0").update(manifest).digest("hex");
		let content = raw;
		if (raw) {
			const firstLine = raw.split("\n", 1)[0];
			const expected = `<!-- pi-plan-project: ${JSON.stringify(this.state.project)} -->`;
			if (firstLine !== expected)
				throw new Error(
					"The saved planning artifact does not belong to this project or has no valid project header.",
				);
			content = raw.slice(firstLine.length + 1);
		}
		return { content, revision, attachments };
	}

	private applyViewed(plan: { content: string; revision: string; attachments: PlanAttachment[] }): void {
		if (plan.revision === this.state.revision) return;
		this.update({
			...plan,
			...(this.state.viewedPlanner === this.state.activePlanner
				? { status: this.state.status === "planning" ? "planning" : "draft" }
				: {}),
			result: "",
		});
	}

	private refreshViewed(): void {
		this.applyViewed(this.readPlanner(this.state.viewedPlanner));
	}

	private watchPlanner(name: string): void {
		const path = this.plannerPath(name);
		if (this.watchedPaths.has(path)) return;
		watchFile(path, { interval: 250, persistent: false }, this.fileChanged);
		this.watchedPaths.add(path);
	}

	private refreshPlanners(): void {
		const names = readdirSync(this.directory, { withFileTypes: true })
			.filter((entry) => entry.isFile() && entry.name.endsWith(".md"))
			.map((entry) => entry.name.slice(0, -3))
			.filter((name) => PLANNER_NAME_PATTERN.test(name))
			.sort((left, right) => (left === "general" ? -1 : right === "general" ? 1 : left.localeCompare(right)));
		for (const name of names) this.watchPlanner(name);
		const planners = names.map((name) => ({ name, hasContent: Boolean(this.readPlanner(name).content.trim()) }));
		if (JSON.stringify(planners) !== JSON.stringify(this.state.planners)) this.update({ planners });
	}

	activatePlanner(name: string): void {
		const path = this.plannerPath(name);
		if (!existsSync(path)) {
			const previous = this.state.activePlanner;
			this.state.activePlanner = name;
			try {
				this.write("");
			} catch (error) {
				this.state.activePlanner = previous;
				throw error;
			}
		}
		this.state.activePlanner = name;
		this.state.viewedPlanner = name;
		this.watchPlanner(name);
		const plan = this.readPlanner(name);
		this.update({
			...plan,
			activePlanner: name,
			viewedPlanner: name,
			status: plan.content.trim() ? "review" : "draft",
			activity: "",
			result: "",
		});
		this.refreshPlanners();
	}

	viewPlanner(name: string): void {
		if (!this.state.planners.some((planner) => planner.name === name)) throw new Error("Planner not found.");
		this.state.viewedPlanner = name;
		this.update({ ...this.readPlanner(name), viewedPlanner: name });
	}

	readActiveContent(): string {
		return this.readPlanner(this.state.activePlanner).content;
	}

	readAllPlans(): Array<{ name: string; content: string; revision: string; active: boolean }> {
		this.refreshPlanners();
		return this.state.planners.map(({ name }) => {
			const plan = this.readPlanner(name);
			return { name, content: plan.content, revision: plan.revision, active: name === this.state.activePlanner };
		});
	}

	workspaceRevision(plans = this.readAllPlans()): string {
		const hash = createHash("sha256");
		for (const plan of plans) hash.update(plan.name).update("\0").update(plan.revision).update("\0");
		return hash.digest("hex");
	}

	assertWorkspaceRevision(revision: string): void {
		if (this.closed || revision !== this.workspaceRevision())
			throw new Error("The approved planning artifacts changed.");
	}

	private parseAttachmentManifest(raw: string): PlanAttachment[] {
		if (!raw.trim()) return [];
		const value: unknown = JSON.parse(raw);
		if (!Array.isArray(value)) throw new Error("The saved plan attachment manifest is invalid.");
		const attachments: PlanAttachment[] = [];
		for (const item of value) {
			if (!item || typeof item !== "object") throw new Error("The saved plan attachment manifest is invalid.");
			const { id, name, mimeType, size } = item as Record<string, unknown>;
			if (
				typeof id !== "string" ||
				!ATTACHMENT_ID_PATTERN.test(id) ||
				typeof name !== "string" ||
				!name ||
				name.length > 255 ||
				typeof mimeType !== "string" ||
				!SUPPORTED_IMAGE_TYPES.has(mimeType) ||
				typeof size !== "number" ||
				!Number.isSafeInteger(size) ||
				size <= 0
			)
				throw new Error("The saved plan attachment manifest is invalid.");
			attachments.push({ id, name, mimeType, size });
		}
		return attachments;
	}

	private attachmentPath(attachment: PlanAttachment, name = this.state.activePlanner): string {
		return join(this.attachmentDirectory(name), `${attachment.id}.${attachment.mimeType.split("/")[1]}`);
	}

	private writeAttachmentManifest(attachments: PlanAttachment[]): void {
		const manifestPath = this.attachmentManifestPath();
		mkdirSync(dirname(manifestPath), { recursive: true, mode: 0o700 });
		const temporary = `${manifestPath}.${this.token}.tmp`;
		writeFileSync(temporary, `${JSON.stringify(attachments, null, 2)}\n`, { mode: 0o600, flag: "wx" });
		renameSync(temporary, manifestPath);
	}

	async addAttachment(name: string, bytes: Uint8Array): Promise<PlanAttachment> {
		if (this.closed) throw new Error("Plan session is closed.");
		if (!name || name.length > 255 || /[\u0000-\u001f\u007f]/.test(name)) throw new Error("Invalid image name.");
		const activeAttachments = this.readPlanner(this.state.activePlanner).attachments;
		if (activeAttachments.length >= MAX_ATTACHMENTS)
			throw new Error(`A plan supports up to ${MAX_ATTACHMENTS} images.`);
		if (bytes.byteLength === 0 || bytes.byteLength > MAX_ATTACHMENT_BYTES)
			throw new Error("Each image must be at most 20 MiB.");
		const detectedMimeType = detectSupportedImageMimeType(bytes);
		if (!detectedMimeType) throw new Error("Unsupported image. Use PNG, JPEG, GIF, WebP, or BMP.");
		const processed = await processImage(bytes, detectedMimeType);
		if (!processed.ok) throw new Error(processed.message);
		const data = Buffer.from(processed.data, "base64");
		const totalBytes = activeAttachments.reduce((total, attachment) => total + attachment.size, 0) + data.byteLength;
		if (totalBytes > MAX_ATTACHMENT_TOTAL_BYTES) throw new Error("Plan images exceed the 50 MiB total limit.");
		const attachment: PlanAttachment = {
			id: randomBytes(12).toString("hex"),
			name,
			mimeType: processed.mimeType,
			size: data.byteLength,
		};
		mkdirSync(this.attachmentDirectory(), { recursive: true, mode: 0o700 });
		writeFileSync(this.attachmentPath(attachment), data, { mode: 0o600, flag: "wx" });
		const previousStatus = this.state.status;
		try {
			this.writeAttachmentManifest([...activeAttachments, attachment]);
		} catch (error) {
			rmSync(this.attachmentPath(attachment));
			throw error;
		}
		this.refresh();
		if (previousStatus === "review") this.update({ status: "review" });
		return attachment;
	}

	removeAttachment(id: string): void {
		const activeAttachments = this.readPlanner(this.state.activePlanner).attachments;
		const attachment = activeAttachments.find((item) => item.id === id);
		if (!attachment) throw new Error("Image attachment not found.");
		const previousStatus = this.state.status;
		this.writeAttachmentManifest(activeAttachments.filter((item) => item.id !== id));
		rmSync(this.attachmentPath(attachment), { force: true });
		this.refresh();
		if (previousStatus === "review") this.update({ status: "review" });
	}

	clearAttachments(): void {
		let attachments = this.readPlanner(this.state.activePlanner).attachments;
		const manifestPath = this.attachmentManifestPath();
		if (attachments.length === 0 && existsSync(manifestPath)) {
			try {
				attachments = this.parseAttachmentManifest(readFileSync(manifestPath, "utf8"));
			} catch {
				// Replacing a plan must still be able to replace a malformed attachment manifest.
			}
		}
		for (const attachment of attachments) rmSync(this.attachmentPath(attachment), { force: true });
		this.writeAttachmentManifest([]);
		this.refresh();
	}

	readAttachmentContent(): Array<{ type: "image"; data: string; mimeType: string }> {
		const attachments = this.readPlanner(this.state.activePlanner).attachments;
		return attachments.map((attachment) => ({
			type: "image",
			data: readFileSync(this.attachmentPath(attachment)).toString("base64"),
			mimeType: attachment.mimeType,
		}));
	}

	readActiveAttachments(): PlanAttachment[] {
		return this.readPlanner(this.state.activePlanner).attachments;
	}

	write(content: string): void {
		if (this.closed) throw new Error("Plan session is closed.");
		if (Buffer.byteLength(content) > MAX_PLAN_BYTES - 4096) throw new Error("Plan exceeds 1 MiB.");
		const raw = `<!-- pi-plan-project: ${JSON.stringify(this.state.project)} -->\n${content}`;
		const temporary = `${this.path}.${this.token}.tmp`;
		writeFileSync(temporary, raw, { mode: 0o600, flag: "wx" });
		renameSync(temporary, this.path);
		this.refresh();
		this.refreshPlanners();
	}

	update(patch: Partial<PlanState>): void {
		Object.assign(this.state, patch);
		const message = `data: ${JSON.stringify(this.state)}\n\n`;
		for (const client of this.clients) {
			if (client.writableLength > 2 * MAX_PLAN_BYTES) {
				client.destroy();
				this.clients.delete(client);
			} else client.write(message);
		}
	}

	assertRevision(revision: string, requireContent = true): void {
		if (this.closed) throw new Error("Plan session is closed.");
		if (this.state.viewedPlanner !== this.state.activePlanner)
			throw new Error("Only the active planner can be changed or approved.");
		const active = this.readPlanner(this.state.activePlanner);
		if (revision !== active.revision || (requireContent && !active.content.trim()))
			throw new Error("The plan changed or is empty. Review the current version.");
	}

	async close(): Promise<void> {
		this.closed = true;
		if (this.watching) for (const path of this.watchedPaths) unwatchFile(path, this.fileChanged);
		for (const client of this.clients) client.end();
		this.clients.clear();
		this.server.closeAllConnections();
		await new Promise<void>((resolve) => this.server.close(() => resolve()));
	}

	private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
		const hosts = [`localhost:${this.port}`, `127.0.0.1:${this.port}`];
		if (!hosts.includes(request.headers.host ?? "")) {
			response.writeHead(403).end();
			return;
		}
		response.setHeader("Cache-Control", "no-store");
		response.setHeader("X-Content-Type-Options", "nosniff");
		response.setHeader("Referrer-Policy", "no-referrer");
		response.setHeader(
			"Content-Security-Policy",
			"default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: https:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
		);
		const url = new URL(request.url ?? "/", `http://${hosts[0]}`);
		if (request.method === "GET" && url.pathname === "/") {
			response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" }).end(planPage);
			return;
		}
		if (request.method === "GET" && url.pathname === "/app.js") {
			const script = readFileSync(join(getPlanWebAssetsDir(), "app.js"), "utf8");
			response.writeHead(200, { "Content-Type": "text/javascript; charset=utf-8" }).end(script);
			return;
		}
		if (request.method === "GET" && url.pathname === "/style.css") {
			const stylesheet = readFileSync(join(getPlanWebAssetsDir(), "..", "style.css"), "utf8");
			response.writeHead(200, { "Content-Type": "text/css; charset=utf-8" }).end(stylesheet);
			return;
		}
		const token = request.headers["x-plan-token"] ?? url.searchParams.get("token");
		if (token !== this.token) {
			response.writeHead(403).end(JSON.stringify({ error: "Open the page using /plan in Pi." }));
			return;
		}
		if (request.method === "GET" && url.pathname === "/events") {
			response.writeHead(200, { "Content-Type": "text/event-stream", Connection: "keep-alive" });
			response.write(`data: ${JSON.stringify(this.state)}\n\n`);
			this.clients.add(response);
			response.on("close", () => this.clients.delete(response));
			return;
		}
		const attachmentMatch = url.pathname.match(/^\/attachments\/([a-f0-9]{24})$/);
		if (request.method === "GET" && attachmentMatch) {
			const attachment = this.state.attachments.find((item) => item.id === attachmentMatch[1]);
			if (!attachment) {
				response.writeHead(404).end();
				return;
			}
			response
				.writeHead(200, {
					"Content-Type": attachment.mimeType,
					"Content-Length": attachment.size,
					"Content-Disposition": `inline; filename*=UTF-8''${encodeURIComponent(attachment.name)}`,
				})
				.end(readFileSync(this.attachmentPath(attachment, this.state.viewedPlanner)));
			return;
		}
		const validOrigin = hosts.some((host) => request.headers.origin === `http://${host}`);
		if (request.method === "POST" && url.pathname === "/view") {
			if (!validOrigin || request.headers["content-type"] !== "application/json") {
				response.writeHead(403).end(JSON.stringify({ error: "Invalid request origin or content type." }));
				return;
			}
			let body = "";
			for await (const chunk of request) {
				body += chunk.toString();
				if (Buffer.byteLength(body) > 4096) throw new Error("Request too large.");
			}
			const value: unknown = JSON.parse(body);
			if (!value || typeof value !== "object" || typeof (value as { planner?: unknown }).planner !== "string")
				throw new Error("Invalid planner selection.");
			this.viewPlanner((value as { planner: string }).planner);
			response.writeHead(200, { "Content-Type": "application/json" }).end("{}");
			return;
		}
		if (request.method === "POST" && url.pathname === "/attachments") {
			if (!validOrigin) {
				response.writeHead(403).end(JSON.stringify({ error: "Invalid request origin." }));
				return;
			}
			if (this.actionPending) throw new Error("An action is already in progress.");
			if (this.state.viewedPlanner !== this.state.activePlanner)
				throw new Error("Only the active planner accepts images.");
			if (!["draft", "review", "blocked", "failed"].includes(this.state.status))
				throw new Error("Wait for Pi to finish before attaching images.");
			const encodedName = request.headers["x-plan-file-name"];
			if (typeof encodedName !== "string") throw new Error("Image name is required.");
			let name: string;
			try {
				name = decodeURIComponent(encodedName);
			} catch {
				throw new Error("Invalid image name.");
			}
			this.actionPending = true;
			try {
				const chunks: Buffer[] = [];
				let size = 0;
				for await (const chunk of request) {
					const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
					size += buffer.byteLength;
					if (size > MAX_ATTACHMENT_BYTES) throw new Error("Each image must be at most 20 MiB.");
					chunks.push(buffer);
				}
				await this.addAttachment(name, Buffer.concat(chunks));
				response.writeHead(200, { "Content-Type": "application/json" }).end("{}");
			} finally {
				this.actionPending = false;
			}
			return;
		}
		if (request.method === "DELETE" && attachmentMatch) {
			if (!validOrigin) {
				response.writeHead(403).end(JSON.stringify({ error: "Invalid request origin." }));
				return;
			}
			if (this.actionPending) throw new Error("An action is already in progress.");
			if (this.state.viewedPlanner !== this.state.activePlanner)
				throw new Error("Only the active planner can remove images.");
			if (!["draft", "review", "blocked", "failed"].includes(this.state.status))
				throw new Error("Wait for Pi to finish before removing images.");
			this.actionPending = true;
			try {
				this.removeAttachment(attachmentMatch[1]);
				response.writeHead(200, { "Content-Type": "application/json" }).end("{}");
			} finally {
				this.actionPending = false;
			}
			return;
		}
		if (request.method !== "POST" || url.pathname !== "/action") {
			response.writeHead(404).end();
			return;
		}
		if (!validOrigin || request.headers["content-type"] !== "application/json") {
			response.writeHead(403).end(JSON.stringify({ error: "Invalid request origin or content type." }));
			return;
		}
		let body = "";
		for await (const chunk of request) {
			body += chunk.toString();
			if (Buffer.byteLength(body) > MAX_ACTION_BYTES) throw new Error("Request too large.");
		}
		const value: unknown = JSON.parse(body);
		if (!value || typeof value !== "object") throw new Error("Invalid action.");
		const action = value as Partial<PlanAction>;
		if (
			!(["approve", "revise", "save", "discard"] as const).includes(
				action.action as "approve" | "revise" | "save" | "discard",
			) ||
			typeof action.revision !== "string" ||
			typeof action.feedback !== "string"
		)
			throw new Error("Invalid action.");
		if (this.actionPending) throw new Error("An action is already in progress.");
		this.assertRevision(
			action.revision,
			action.action === "approve" || action.action === "revise" || action.action === "save",
		);
		if (action.action === "approve" && this.state.status !== "review")
			throw new Error("The planner must finish before approval.");
		const idleStatuses: PlanStatus[] = ["draft", "review", "completed", "blocked", "failed"];
		if (action.action === "revise" && (!action.feedback.trim() || !idleStatuses.includes(this.state.status)))
			throw new Error("Wait for Pi to finish and enter your observations.");
		if (action.action === "save" && !idleStatuses.includes(this.state.status))
			throw new Error("Wait for Pi to finish before editing the plan.");
		if (action.action === "discard" && !idleStatuses.includes(this.state.status))
			throw new Error("Wait for Pi to finish before discarding the plan.");
		this.actionPending = true;
		try {
			await this.onAction(action as PlanAction);
			response.writeHead(200, { "Content-Type": "application/json" }).end("{}");
		} finally {
			this.actionPending = false;
		}
	}
}
