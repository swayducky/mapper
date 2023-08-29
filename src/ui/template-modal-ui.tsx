import { App, Modal } from "obsidian";
import * as React from "react";
import ReactDOM from "react-dom";
import TextGeneratorPlugin from "src/main";
import { TemplateModalView } from "./template-modal-view";

export class TemplateModalUI extends Modal {
	result: string;
	plugin: TextGeneratorPlugin;
	onSubmit: (result: string) => void;
	variables: string[];
	metadata: any;
	templateContext: any;

	constructor(
		app: App,
		plugin: TextGeneratorPlugin,
		variables: string[],
		metadata: any,
		templateContext: any,
		onSubmit: (result: string) => void
	) {
		super(app);
		this.plugin = plugin;
		this.onSubmit = onSubmit;
		this.variables = variables;
		this.metadata = metadata;
		this.templateContext = templateContext;
	}

	async onOpen() {
		this.containerEl.createEl("div", { cls: "PackageManager" });
		const renderTarget = this.containerEl.children[1];
		ReactDOM.render(
			<React.StrictMode>
				<TemplateModalView
					p={this}
					labels={this.variables}
					templateContext={this.templateContext}
					onSubmit={this.onSubmit}
					metadata={this.metadata}
				/>
			</React.StrictMode>,
			renderTarget
		);
	}

	onClose() {
		ReactDOM.unmountComponentAtNode(this.containerEl.children[1]);
	}
}
