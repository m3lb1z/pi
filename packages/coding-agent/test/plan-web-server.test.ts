import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PlanServer, type PlanState } from "../src/core/plan-web/server.ts";

const servers: PlanServer[] = [];
const directories: string[] = [];

afterEach(async () => {
	await Promise.all(servers.splice(0).map((server) => server.close()));
	for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

async function setup(handler = vi.fn(async () => {})) {
	const directory = mkdtempSync(join(tmpdir(), "pi-plan-server-"));
	directories.push(directory);
	const path = join(directory, "plan_current.md");
	const server = new PlanServer(path, directory, handler);
	servers.push(server);
	await server.start(0);
	const url = new URL(server.url);
	const base = url.origin;
	const headers = { "Content-Type": "application/json", "X-Plan-Token": server.token, Origin: base };
	const post = (action = "approve", revision = server.state.revision, feedback = "") =>
		fetch(`${base}/action`, {
			method: "POST",
			headers,
			body: JSON.stringify({ action, revision, feedback }),
		});
	return { server, path, base, headers, post, handler, directory };
}

describe("plan web server", () => {
	it("serves the page without exposing plan contents or the approval token", async () => {
		const { server, base } = await setup();
		server.write("private task");
		const pageResponse = await fetch(base);
		const page = await pageResponse.text();
		const appResponse = await fetch(`${base}/app.js`);
		const app = await appResponse.text();
		expect(page).toContain('<div id="root"></div>');
		expect(page).toContain('<script src="/app.js"></script>');
		expect(pageResponse.headers.get("content-security-policy")).toContain("script-src 'self'");
		expect(appResponse.headers.get("content-type")).toBe("text/javascript; charset=utf-8");
		expect(app).toContain("Aprobar y ejecutar");
		expect(app).toContain("Crear nuevo plan");
		expect(app).toContain("Descartar");
		expect(app).toContain("language-mermaid");
		expect(page).not.toContain("<textarea");
		expect(page).not.toContain("private task");
		expect(page).not.toContain(server.token);
		expect((await fetch(`${base}/events`)).status).toBe(403);
	});

	it("streams persisted writes and external changes without a page reload", async () => {
		const { server, path, base } = await setup();
		const abort = new AbortController();
		const response = await fetch(`${base}/events?token=${server.token}`, { signal: abort.signal });
		const reader = response.body!.getReader();
		try {
			await reader.read();
			server.write("# First plan");
			const update = new TextDecoder().decode((await reader.read()).value);
			expect(update).toContain("# First plan");
			expect(readFileSync(path, "utf8")).toContain("# First plan");
			server.update({ status: "review" });
			await reader.read();
			writeFileSync(path, readFileSync(path, "utf8").replace("First", "Revised"));
			const external = new TextDecoder().decode((await reader.read()).value);
			const state = JSON.parse(external.slice(6)) as PlanState;
			expect(state.content).toBe("# Revised plan");
			expect(state.status).toBe("draft");
		} finally {
			abort.abort();
		}
	});

	it("rejects approval while planning, stale versions, empty plans, and cross-origin requests", async () => {
		const { server, path, base, headers, post, handler } = await setup();
		expect((await post()).status).toBe(409);
		server.update({ status: "planning" });
		server.write("original");
		expect((await post()).status).toBe(409);
		server.update({ status: "review" });
		const revision = server.state.revision;
		writeFileSync(path, readFileSync(path, "utf8").replace("original", "changed"));
		expect((await post("approve", revision)).status).toBe(409);
		server.update({ status: "review" });
		const response = await fetch(`${base}/action`, {
			method: "POST",
			headers: { ...headers, Origin: "https://example.com" },
			body: JSON.stringify({ action: "approve", revision: server.state.revision, feedback: "" }),
		});
		expect(response.status).toBe(403);
		expect(handler).not.toHaveBeenCalled();
	});

	it("admits only one approval when clicks overlap", async () => {
		let release: () => void = () => {};
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const handler = vi.fn(async () => gate);
		const { server, post } = await setup(handler);
		server.write("plan");
		server.update({ status: "review" });
		const first = post();
		await vi.waitFor(() => expect(handler).toHaveBeenCalledTimes(1));
		try {
			expect((await post()).status).toBe(409);
		} finally {
			release();
		}
		expect((await first).status).toBe(200);
		expect(handler).toHaveBeenCalledTimes(1);
	});

	it("delivers revision feedback and keeps the persisted plan after restart", async () => {
		const { server, post, path, handler, directory } = await setup();
		server.write("persisted plan");
		server.update({ status: "review" });
		expect((await post("revise", server.state.revision, "Add validation")).status).toBe(200);
		expect(handler).toHaveBeenCalledWith({
			action: "revise",
			revision: server.state.revision,
			feedback: "Add validation",
		});
		await server.close();
		const reopened = new PlanServer(path, directory, async () => {});
		servers.push(reopened);
		await reopened.start(0);
		expect(reopened.state.content).toBe("persisted plan");
		expect(reopened.state.status).toBe("draft");
	});

	it("accepts new-plan and discard actions only while idle", async () => {
		const { server, post, handler } = await setup();
		server.write("current plan");
		server.update({ status: "review" });
		expect((await post("new", server.state.revision)).status).toBe(409);
		expect((await post("new", server.state.revision, "Build another feature")).status).toBe(200);
		expect(handler).toHaveBeenLastCalledWith({
			action: "new",
			revision: server.state.revision,
			feedback: "Build another feature",
		});
		expect((await post("discard", server.state.revision)).status).toBe(200);
		server.update({ status: "executing" });
		expect((await post("discard", server.state.revision)).status).toBe(409);
	});

	it("rejects another project and releases its listener on initialization failure", async () => {
		const { server, path } = await setup();
		server.write("original project");
		await server.close();
		const other = new PlanServer(path, "/different/project", async () => {});
		servers.push(other);
		await expect(other.start(0)).rejects.toThrow("another project");
		expect(readFileSync(path, "utf8")).toContain("original project");
	});

	it("fails rather than sharing the plan with a second listening terminal", async () => {
		const { server, path, directory } = await setup();
		const other = new PlanServer(path, directory, async () => {});
		servers.push(other);
		await expect(other.start(Number(new URL(server.url).port))).rejects.toMatchObject({ code: "EADDRINUSE" });
	});
});
