import { Container, type SettingItem, SettingsList, type TUI } from "@earendil-works/pi-tui";
import type { ScopedModel } from "../../../core/model-resolver.ts";
import { getSettingsListTheme } from "../theme/theme.ts";
import { DynamicBorder } from "./dynamic-border.ts";
import { ModelSelectorComponent, type ModelSelectorSource } from "./model-selector.ts";

export type PlanMode = "planner" | "programming";

export interface PlanModeModelChoice {
	provider: string;
	id: string;
}

export type PlanModeModels = Partial<Record<PlanMode, PlanModeModelChoice>>;

function displayChoice(choice: PlanModeModelChoice | undefined): string {
	return choice ? `${choice.id} [${choice.provider}]` : "Default model";
}

export class PlanModeSelectorComponent extends Container {
	private readonly settingsList: SettingsList;

	constructor(
		tui: TUI,
		modelSource: ModelSelectorSource,
		scopedModels: readonly ScopedModel[],
		config: PlanModeModels,
		onChange: (mode: PlanMode, choice: PlanModeModelChoice | undefined) => void,
		onCancel: () => void,
	) {
		super();

		const items: SettingItem[] = (["planner", "programming"] as const).map((mode) => ({
			id: mode,
			label: mode === "planner" ? "Planner model" : "Programming model",
			description:
				mode === "planner"
					? "Model used to create and revise plan_current.md"
					: "Model used after the browser approves the plan",
			currentValue: displayChoice(config[mode]),
			submenu: (_value, done) => {
				const choice = config[mode];
				const selected = choice ? modelSource.getModel(choice.provider, choice.id) : undefined;
				const source =
					mode === "planner"
						? {
								getAvailableSnapshot: () =>
									modelSource.getAvailableSnapshot().filter((model) => model.reasoning),
								getError: () => modelSource.getError(),
								getModel: (provider: string, id: string) => {
									const model = modelSource.getModel(provider, id);
									return model?.reasoning ? model : undefined;
								},
								refresh: (options: Parameters<ModelSelectorSource["refresh"]>[0]) =>
									modelSource.refresh(options),
							}
						: modelSource;
				const availableScopedModels =
					mode === "planner" ? scopedModels.filter(({ model }) => model.reasoning) : scopedModels;
				return new ModelSelectorComponent(
					tui,
					selected,
					source,
					availableScopedModels,
					(model) => {
						const next = { provider: model.provider, id: model.id };
						config[mode] = next;
						onChange(mode, next);
						done(displayChoice(next));
					},
					() => done(),
					undefined,
					undefined,
					undefined,
					() => {
						delete config[mode];
						onChange(mode, undefined);
						done(displayChoice(undefined));
					},
				);
			},
		}));

		this.addChild(new DynamicBorder());
		this.settingsList = new SettingsList(items, items.length, getSettingsListTheme(), () => {}, onCancel);
		this.addChild(this.settingsList);
		this.addChild(new DynamicBorder());
	}

	handleInput(data: string): void {
		this.settingsList.handleInput(data);
	}
}
