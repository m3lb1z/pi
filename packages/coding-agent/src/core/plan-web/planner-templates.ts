import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { CONFIG_DIR_NAME } from "../../config.ts";
import { stripBom } from "../../utils/text.ts";
import type { ExtensionContext } from "../extensions/types.ts";

export interface PlannerTemplate {
	name: string;
	instructions: string;
}

const PLANNER_NAME_PATTERN = /^[a-z][a-z0-9-]{0,63}$/;

const BUILTIN_PLANNERS: Record<string, string> = {
	general:
		"Create a concise implementation plan covering objective, scope, decisions, ordered steps, validation, and open questions.",
	design:
		"Describe the target architecture, component boundaries, data flow, interfaces, decisions, tradeoffs, and risks. Use Mermaid architecture or flow diagrams when they materially clarify the design.",
	uml: "Describe the system through relevant UML views. Use Mermaid class, sequence, state, requirement, or flow diagrams as appropriate, and accompany each diagram with the decisions it communicates.",
	sdd: "Create a Spec-Driven Development artifact with observable requirements, scenarios, contracts, constraints, acceptance criteria, and traceability from requirements to implementation work.",
};

export function readPlannerTemplate(name: string, ctx: ExtensionContext, directory: string): PlannerTemplate {
	if (!PLANNER_NAME_PATTERN.test(name))
		throw new Error(
			"Planner names must start with a lowercase letter and contain only lowercase letters, numbers, or hyphens.",
		);
	const projectPath = join(ctx.cwd, CONFIG_DIR_NAME, "planners", name, "PLANNER.md");
	const globalPath = join(directory, "planners", name, "PLANNER.md");
	const path = ctx.isProjectTrusted() && existsSync(projectPath) ? projectPath : globalPath;
	if (existsSync(path)) return { name, instructions: stripBom(readFileSync(path, "utf8")).trim() };
	const instructions = BUILTIN_PLANNERS[name];
	if (!instructions)
		throw new Error(
			`Planner '${name}' is not defined. Add ${join(CONFIG_DIR_NAME, "planners", name, "PLANNER.md")} to the project or configure it globally.`,
		);
	return { name, instructions };
}
