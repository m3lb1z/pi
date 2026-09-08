import type { InlineExtension } from "../core/extensions/types.ts";
import planWebExtension from "../core/plan-web/extension.ts";
import llamaExtension from "./llama/index.ts";

export const builtInExtensions: InlineExtension[] = [
	{ name: "llama.cpp", factory: llamaExtension, hidden: true },
	{ name: "plan-web", factory: planWebExtension, hidden: true },
];
