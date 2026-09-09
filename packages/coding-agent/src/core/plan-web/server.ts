import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, unwatchFile, watchFile, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { dirname, join } from "node:path";
import { getPlanWebAssetsDir } from "../../config.ts";
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
	content: string;
	revision: string;
	status: PlanStatus;
	activity: string;
	result: string;
}
export interface PlanAction {
	action: "approve" | "revise" | "save" | "discard" | "new";
	revision: string;
	feedback: string;
}

const MAX_PLAN_BYTES = 1024 * 1024;
const MAX_ACTION_BYTES = MAX_PLAN_BYTES * 6 + 64 * 1024;

/** One listening process owns a project plan. Approval always rechecks the disk revision. */
export class PlanServer {
	readonly path: string;
	readonly token = randomBytes(32).toString("hex");
	readonly state: PlanState;
	private server: Server;
	private clients = new Set<ServerResponse>();
	private actionPending = false;
	private port = 7337;
	private watching = false;
	private closed = false;
	private onAction: (action: PlanAction) => Promise<void>;

	constructor(path: string, project: string, onAction: (action: PlanAction) => Promise<void>) {
		this.path = path;
		this.onAction = onAction;
		this.state = { project, content: "", revision: "", status: "draft", activity: "", result: "" };
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

	async start(port?: number, replacing = false): Promise<void> {
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
			mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
			if (!replacing) this.refresh();
			watchFile(this.path, { interval: 250, persistent: false }, this.fileChanged);
			this.watching = true;
		} catch (error) {
			await this.close();
			throw error;
		}
	}

	private fileChanged = (): void => {
		try {
			this.refresh();
		} catch (error) {
			this.update({ status: "blocked", result: String(error) });
		}
	};

	refresh(): void {
		const raw = existsSync(this.path) ? readFileSync(this.path, "utf8") : "";
		if (Buffer.byteLength(raw) > MAX_PLAN_BYTES) throw new Error("Plan exceeds 1 MiB.");
		const revision = createHash("sha256").update(raw).digest("hex");
		if (revision === this.state.revision) return;
		let content = raw;
		if (raw) {
			const firstLine = raw.split("\n", 1)[0];
			const expected = `<!-- pi-plan-project: ${JSON.stringify(this.state.project)} -->`;
			if (firstLine !== expected)
				throw new Error(
					"The saved plan does not belong to this project or has no valid project header. Use /plan <task> to replace it.",
				);
			content = raw.slice(firstLine.length + 1);
		}
		this.update({ content, revision, status: this.state.status === "planning" ? "planning" : "draft", result: "" });
	}

	write(content: string): void {
		if (this.closed) throw new Error("Plan session is closed.");
		if (Buffer.byteLength(content) > MAX_PLAN_BYTES - 4096) throw new Error("Plan exceeds 1 MiB.");
		const raw = `<!-- pi-plan-project: ${JSON.stringify(this.state.project)} -->\n${content}`;
		const temporary = `${this.path}.${this.token}.tmp`;
		writeFileSync(temporary, raw, { mode: 0o600, flag: "wx" });
		renameSync(temporary, this.path);
		this.refresh();
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
		this.refresh();
		if (revision !== this.state.revision || (requireContent && !this.state.content.trim()))
			throw new Error("The plan changed or is empty. Review the current version.");
	}

	async close(): Promise<void> {
		this.closed = true;
		if (this.watching) unwatchFile(this.path, this.fileChanged);
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
		if (request.method !== "POST" || url.pathname !== "/action") {
			response.writeHead(404).end();
			return;
		}
		if (
			!hosts.some((host) => request.headers.origin === `http://${host}`) ||
			request.headers["content-type"] !== "application/json"
		) {
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
			!(["approve", "revise", "save", "discard", "new"] as const).includes(
				action.action as "approve" | "revise" | "save" | "discard" | "new",
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
		if (action.action === "new" && (!action.feedback.trim() || !idleStatuses.includes(this.state.status)))
			throw new Error("Wait for Pi to finish and describe the new task.");
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
