import { App, Modal } from "obsidian";
import TextGeneratorPlugin from "src/main";
import * as React from "react";
import { PackageManagerView } from "./package-manager-view";
import ReactDOM from "react-dom";

export class PackageManagerUI extends Modal {
	result: string;
	plugin: TextGeneratorPlugin;
	onSubmit: (result: string) => void;
	root: any;

	constructor(
		app: App,
		plugin: TextGeneratorPlugin,
		onSubmit: (result: string) => void
	) {
		super(app);
		this.plugin = plugin;
		this.onSubmit = onSubmit;
		this.modalEl.addClasses(["mod-settings", "mod-sidebar-layout"]);
	}

	async onOpen() {
		this.containerEl.createEl("div", { cls: "PackageManager" });
		const renderTarget = this.containerEl.children[1];
		ReactDOM.render(
			<React.StrictMode>
				<PackageManagerView parent={this} />,
			</React.StrictMode>,
			renderTarget
		);
	}

	onClose() {
		this.root.unmount();
	}
}
