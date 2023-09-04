import { TemplateModalUI } from "./ui/template-modal-ui";
import { App, Notice, Editor, RequestUrlParam, EditorPosition } from "obsidian";
import { TextGeneratorSettings } from "./types";
import TextGeneratorPlugin from "./main";
import ReqFormatter from "./api-request-formatter";
import { SetPath } from "./ui/settings/set-path";
import ContextManager from "./context-manager";
import {
	makeid,
	createFileWithInput,
	openFile,
	removeYAML,
	getTitleFromPath,
} from "./utils";
import safeAwait from "safe-await";
import debug from "debug";
const logger = debug("textgenerator:TextGenerator");
import { SSE } from "sse";
export default class TextGenerator {
	plugin: TextGeneratorPlugin;
	app: App;
	reqFormatter: ReqFormatter;
	contextManager: ContextManager;
	signal: AbortSignal;
	sse: any;

	constructor(app: App, plugin: TextGeneratorPlugin) {
		this.app = app;
		this.plugin = plugin;

		this.contextManager = new ContextManager(app, plugin);
		this.reqFormatter = new ReqFormatter(app, plugin, this.contextManager);
	}

	async generate(
		context: any,
		insertMetadata = false,
		params: any = this.plugin.settings,
		templatePath = "",
		additionnalParams: any = {
			showSpinner: true,
		}
	) {
		logger("generate", {
			context,
			insertMetadata,
			params,
			templatePath,
			additionnalParams,
		});
		const { options, template } = context;
		const prompt = template
			? template.inputTemplate(options)
			: context.context;

		if (this.plugin.processing) {
			logger("generate error", "There is another generation process");
			return Promise.reject(
				new Error("There is another generation process")
			);
		}
		this.plugin.startProcessing(additionnalParams?.showSpinner);
		const { reqParams } = this.reqFormatter.getRequestParameters(
			{
				...params,
				prompt,
			},
			insertMetadata,
			templatePath,
			additionnalParams
		);
		try {
			let result = await this.getGeneratedText(reqParams);

			// Remove leading/trailing newlines

			result = template?.outputTemplate
				? template.outputTemplate({ ...options, output: result })
				: result;
			logger("generate end", {
				result,
			});
			return result;
		} catch (error) {
			logger("generate error", error);
			return Promise.reject(error);
		} finally {
			this.plugin.endProcessing(additionnalParams?.showSpinner);
		}
	}

	async streamGenerate(
		context: any,
		insertMetadata = false,
		params: any = this.plugin.settings,
		templatePath = "",
		additionnalParams: any = {
			showSpinner: true,
		}
	) {
		logger("generate", {
			context,
			insertMetadata,
			params,
			templatePath,
			additionnalParams,
		});
		const { options, template } = context;
		const prompt = template
			? template.inputTemplate(options)
			: context.context;

		if (this.plugin.processing) {
			logger(
				"streamGenerate error",
				"There is another generation process"
			);
			return Promise.reject(
				new Error("There is another generation process")
			);
		}
		const { reqParams } = this.reqFormatter.getRequestParameters(
			{
				...params,
				prompt,
			},
			insertMetadata,
			templatePath,
			additionnalParams
		);
		try {
			//const stream = await this.streamRequest(reqParams);
			const stream = await this.sseRequest(reqParams);
			logger("streamGenerate end", {
				stream,
			});

			return stream;
		} catch (error) {
			logger("streamGenerate error", error);
			return Promise.reject(error);
		}
	}
	async gen(prompt, settings = {}) {
		console.log("gen ", prompt, settings);
		const params = { ...this.plugin.settings, ...settings };
		const { reqParams } = this.reqFormatter.getRequestParameters(
			{
				...params,
				prompt,
			},
			false,
			""
		);

		try {
			const result = await this.getGeneratedText(reqParams);

			logger("gen results", {
				result,
			});
			return result;
		} catch (error) {
			logger("gen  error", error);
			return Promise.reject(error);
		}
	}

	getCursor(editor: Editor) {
		logger("getCursor");
		let cursor = editor.getCursor();
		let selectedText = editor.getSelection();
		if (selectedText.length === 0) {
			const lineNumber = editor.getCursor().line;
			selectedText = editor.getLine(lineNumber);
			if (selectedText.length !== 0) {
				cursor.ch = selectedText.length;
				if (selectedText[selectedText.length - 1] === " ") {
					cursor.ch = selectedText.length - 1;
				}
			}
		}
		logger("getCursor end");
		return cursor;
	}

	async generateFromTemplate(
		params: TextGeneratorSettings,
		templatePath: string,
		insertMetadata: boolean = true,
		editor: Editor,
		activeFile: boolean = true
	) {
		logger("generateFromTemplate");
		const cursor = this.getCursor(editor);

		const [errorContext, context] = await safeAwait(
			this.contextManager.getContext(editor, insertMetadata, templatePath)
		);
		const [errorGeneration, text] = await safeAwait(
			this.generate(context, insertMetadata, params, templatePath)
		);

		if (errorContext) {
			return Promise.reject(errorContext);
		}

		if (errorGeneration) {
			return Promise.reject(errorGeneration);
		}

		if (activeFile === false) {
			const title = this.app.workspace.activeLeaf.getDisplayText();
			let suggestedPath =
				"textgenerator/generations/" + title + "-" + makeid(3) + ".md";

			new SetPath(this.app, suggestedPath, async (path: string) => {
				const [errorFile, file] = await safeAwait(
					createFileWithInput(path, context.context + text, this.app)
				);
				if (errorFile) {
					return Promise.reject(errorFile);
				}

				openFile(this.app, file);
			}).open();
		} else {
			const mode = this.getMode(context);
			this.insertGeneratedText(text, editor, cursor, mode, "YOO");
		}
		logger("generateFromTemplate end");
	}

	getMode(context: any) {
		return context?.options?.frontmatter?.config?.mode || "insert";
	}

	async generateStreamInEditor(
		params: TextGeneratorSettings,
		insertMetadata: boolean = false,
		editor: Editor
	) {
		logger("generateStreamInEditor");
		let cursor = this.getCursor(editor);
		const context = await this.contextManager.getContext(
			editor,
			insertMetadata
		);

		const [errorGeneration, sse] = await safeAwait(
			this.streamGenerate(context, insertMetadata, params)
		);

		sse.addEventListener("message", (e: any) => {
			if (e.data != "[DONE]") {
				const payload = JSON.parse(e.data);
				const content = payload.choices[0].delta.content;
				logger("generateStreamInEditor message", { payload, content });
				const cursor = editor.getCursor();
				this.insertGeneratedText(
					content,
					editor,
					cursor,
					"stream",
					"YOOO2"
				);

				const newCursor = {
					line: cursor.line,
					ch: cursor.ch + content?.length,
				};

				editor.setCursor(newCursor);
			} else {
				sse.close();
			}
		});

		sse.addEventListener("error", (error: any) => {
			return Promise.reject(error);
		});
		this.sse = sse;
		sse.stream();

		if (errorGeneration) {
			return Promise.reject(errorGeneration);
		}
	}

	async generateInEditor(
		params: TextGeneratorSettings,
		insertMetadata: boolean = false,
		editor: Editor
	) {
		if (this.plugin.settings.stream) {
			return this.generateStreamInEditor(params, insertMetadata, editor);
		}

		logger("generateInEditor");
		const cursor = this.getCursor(editor);
		const context = await this.contextManager.getContext(
			editor,
			insertMetadata
		);
		const [errorGeneration, text] = await safeAwait(
			this.generate(context, insertMetadata, params)
		);

		if (errorGeneration) {
			return Promise.reject(errorGeneration);
		}
		const mode = this.getMode(context);
		this.insertGeneratedText(text, editor, cursor, mode, "AI");
		logger("generateInEditor end");
	}
	async;
	async generateToClipboard(
		params: TextGeneratorSettings,
		templatePath: string,
		insertMetadata: boolean = false,
		editor: Editor
	) {
		logger("generateToClipboard");
		const [errorContext, context] = await safeAwait(
			this.contextManager.getContext(editor, insertMetadata, templatePath)
		);
		const [errorGeneration, text] = await safeAwait(
			this.generate(context, insertMetadata, params, templatePath)
		);

		if (errorContext) {
			return Promise.reject(errorContext);
		}

		if (errorGeneration) {
			return Promise.reject(errorGeneration);
		}
		const data = new ClipboardItem({
			"text/plain": new Blob([text], {
				type: "text/plain",
			}),
		});
		await navigator.clipboard.write([data]);
		new Notice("Generated Text copied to clipboard");
		editor.setCursor(editor.getCursor());
		logger("generateToClipboard end");
	}

	async generatePrompt(
		promptText: string,
		insertMetadata: boolean = false,
		editor: Editor,
		outputTemplate: any
	) {
		logger("generatePrompt");
		const cursor = this.getCursor(editor);
		let [errorGeneration, text] = await safeAwait(
			this.generate({ context: promptText }, insertMetadata)
		);

		if (errorGeneration) {
			return Promise.reject(errorGeneration);
		}
		if (outputTemplate) {
			text = outputTemplate({ output: text });
		}
		this.insertGeneratedText(text, editor, cursor);
		logger("generatePrompt end");
	}

	async createToFile(
		params: TextGeneratorSettings,
		templatePath: string,
		insertMetadata: boolean = false,
		editor: Editor,
		activeFile: boolean = true
	) {
		logger("createToFile");
		const [errorContext, context] = await safeAwait(
			this.contextManager.getContext(editor, insertMetadata, templatePath)
		);

		if (errorContext) {
			return Promise.reject(errorContext);
		}
		const contextAsString = context.context;
		if (activeFile === false) {
			const title = this.app.workspace.activeLeaf.getDisplayText();
			let suggestedPath =
				"textgenerator/generations/" + title + "-" + makeid(3) + ".md";

			new SetPath(this.app, suggestedPath, async (path: string) => {
				const [errorFile, file] = await safeAwait(
					createFileWithInput(path, contextAsString, this.app)
				);

				if (errorFile) {
					logger("createToFile error", errorFile);
					return Promise.reject(errorFile);
				}

				openFile(this.app, file);
			}).open();
		} else {
			const mode = this.getMode(context);
			this.insertGeneratedText(
				contextAsString,
				editor,
				undefined,
				mode,
				"YO4"
			);
		}
		logger("createToFile end");
	}

	async createTemplateFromEditor(editor: Editor) {
		logger("createTemplateFromEditor");
		const title = this.app.workspace.activeLeaf.getDisplayText();
		const content = editor.getValue();
		await this.createTemplate(content, title);
		logger("createTemplateFromEditor end");
	}

	async createTemplate(content: string, title: string = "") {
		logger("createTemplate");
		const promptInfo = `PromptInfo:
 promptId: ${title}
 name: 🗞️${title} 
 description: ${title}
 required_values: 
 author: 
 tags: 
 version: 0.0.1`;

		let templateContent = content;
		const metadata = this.contextManager.getMetaData();
		// We have three cases: no Front-matter / Frontmatter without PromptInfo/ Frontmatter with PromptInfo
		if (!metadata.hasOwnProperty("frontmatter")) {
			templateContent = `---\n${promptInfo}\n---\n${templateContent}`;
		} else if (!metadata["frontmatter"].hasOwnProperty("PromptInfo")) {
			if (templateContent.indexOf("---") !== -1) {
				templateContent = templateContent.replace(
					"---",
					`---\n${promptInfo}`
				);
			} else {
				templateContent = `---\n${promptInfo}\n---\n${templateContent}`;
			}
		}
		const suggestedPath = `${this.plugin.settings.promptsPath}/local/${title}.md`;
		new SetPath(this.app, suggestedPath, async (path: string) => {
			const [errorFile, file] = await safeAwait(
				createFileWithInput(path, templateContent, this.app)
			);
			if (errorFile) {
				logger("createTemplate error", errorFile);
				return Promise.reject(errorFile);
			}
			openFile(this.app, file);
		}).open();
		logger("createTemplate end");
	}

	async getGeneratedText(reqParams: any) {
		logger("getGeneratedText");
		const extractResult = reqParams?.extractResult;
		delete reqParams?.extractResult;
		let [errorRequest, requestResults] = await safeAwait(
			this.request(reqParams)
		);

		if (errorRequest) {
			logger("getGeneratedText error", requestResults, errorRequest);
			return Promise.reject(errorRequest);
		}
		const text = eval(extractResult);
		logger("getGeneratedText  end", {
			requestResults,
			extractResult,
			text,
		});
		return text;
	}

	async request(params: RequestUrlParam) {
		return new Promise((resolve, reject) => {
			const controller = new AbortController();
			this.signal = controller.signal;
			const timeoutId = setTimeout(() => {
				controller.abort();
				reject(new Error("Timeout Reached"));
			}, this.plugin.settings.requestTimeout);
			const raw = params.body;
			const requestOptions = {
				method: params.method,
				headers: params.headers,
				body: raw,
				redirect: "follow",
				signal: this.signal,
			};

			logger({ params, requestOptions });
			fetch(params.url, requestOptions)
				.then((response) => response.json())
				.then((result) => {
					clearTimeout(timeoutId);
					if (result.error) {
						reject(result.error);
					} else {
						resolve(result);
					}
				})
				.catch((error) => {
					reject(error);
				});
		});
	}

	async streamRequest(params: RequestUrlParam) {
		return new Promise(async (resolve, reject) => {
			const controller = new AbortController();
			this.signal = controller.signal;
			const timeoutId = setTimeout(() => {
				controller.abort();
				reject(new Error("Timeout Reached"));
			}, this.plugin.settings.requestTimeout);
			const raw = params.body;
			const requestOptions = {
				method: params.method,
				headers: params.headers,
				body: raw,
				redirect: "follow",
				signal: this.signal,
			};

			logger({ params, requestOptions });

			try {
				clearTimeout(timeoutId);
				const response = await fetch(params.url, requestOptions);
				const reader = response.body.getReader();
				resolve(reader);
			} catch (error) {
				reject(error);
			}
		});
	}

	async sseRequest(params: RequestUrlParam) {
		return new Promise(async (resolve, reject) => {
			const controller = new AbortController();
			this.signal = controller.signal;
			const raw = JSON.stringify({
				...JSON.parse(params.body),
				stream: true,
			});

			const source = new SSE(params.url, {
				headers: params.headers,
				method: "POST",
				payload: raw,
			});

			resolve(source);
		});
	}

	outputToBlockQuote(text: string, title: string) {
		let lines = text
			.split("\n")
			// .map((line) => line.trim())
			.filter((line) => line !== "" && line !== ">");
		lines = lines
			.map((line, index) => {
				if (line.includes("[!ai]+ AI")) {
					return ">";
				}

				return line.startsWith(">") ? line : "> " + line;
			})
			.filter((line) => line !== "");

		return (
			"\n> [!ai]+ " +
			(title || "AI") +
			"\n>\n" +
			lines.join("\n").trim() +
			"\n\n"
		);
	}

	async insertGeneratedText(
		completion: string,
		editor: Editor,
		cur: EditorPosition = null,
		mode: string = "insert",
		title: string = ""
	) {
		const logger = (message) => console.log(message);
		logger("insertGeneratedText");

		let text = completion;
		if (mode !== "stream") {
			text = this.plugin.settings.prefix.replace(/\\n/g, "\n") + text;
		}

		let cursor = this.getCursor(editor);
		if (cur) {
			cursor = cur;
		}

		if (editor.listSelections().length > 0) {
			const anchor = editor.listSelections()[0].anchor;
			const head = editor.listSelections()[0].head;
			if (
				anchor.line > head.line ||
				(anchor.line === head.line && anchor.ch > head.ch)
			) {
				cursor = editor.listSelections()[0].anchor;
			}
		}

		if (this.plugin.settings.outputToBlockQuote && mode !== "stream") {
			text = this.outputToBlockQuote(text, title);
		}

		if (mode === "insert" || mode === "stream") {
			// let final = text;
			// if (!text.startsWith("\n")) final = "\n" + text;
			editor.replaceRange(text, cursor);
		} else if (mode === "replace") {
			editor.replaceSelection(text);
		} else if (mode === "rename") {
			const sanitizedTitle = text
				.replace(/[*\\"/<>:|?\.]/g, "")
				.replace(/^\n*/g, "");
			const activeFile = this.app.workspace.getActiveFile();
			const renamedFilePath = activeFile.path.replace(
				activeFile.name,
				`${sanitizedTitle}.md`
			);
			await this.app.fileManager.renameFile(activeFile, renamedFilePath);
		}

		editor.setCursor(editor.getCursor());
		logger("insertGeneratedText end");
	}

	async tempalteToModal(
		params: any = this.plugin.settings,
		templatePath = "",
		editor: Editor,
		activeFile = true
	) {
		logger("tempalteToModal");
		const templateFile = this.app.vault.getAbstractFileByPath(templatePath);
		let [errortemplateContent, templateContent] = await safeAwait(
			this.app.vault.read(templateFile)
		);
		if (errortemplateContent) {
			return Promise.reject(errortemplateContent);
		}

		const { inputContent } =
			this.contextManager.splitTemplate(templateContent);

		const variables = this.contextManager
			.extractVariablesFromTemplate(inputContent)
			.filter((variable) => !variable.includes("."));

		const metadata = this.getMetadata(templatePath);
		const tempateContext = await this.contextManager.getTemplateContext(
			editor,
			templatePath
		);
		new TemplateModalUI(
			this.app,
			this.plugin,
			variables,
			metadata,
			tempateContext,
			async (results: any) => {
				const cursor = this.getCursor(editor);

				const [errorContext, context] = await safeAwait(
					this.contextManager.getContext(
						editor,
						true,
						templatePath,
						results
					)
				);
				if (errorContext) {
					logger("tempalteToModal error", errorContext);
					return Promise.reject(errorContext);
				}

				const [errortext, text] = await safeAwait(
					this.generate(context, true, params, templatePath)
				);
				if (errortext) {
					logger("tempalteToModal error", errortext);
					return Promise.reject(errortext);
				}

				if (activeFile === false) {
					const title =
						this.app.workspace.activeLeaf.getDisplayText();
					const suggestedPath =
						"textgenerator/generations/" +
						title +
						"-" +
						makeid(3) +
						".md";
					new SetPath(
						this.app,
						suggestedPath,
						async (path: string) => {
							const [errorFile, file] = await safeAwait(
								createFileWithInput(
									path,
									context.context + text,
									this.app
								)
							);
							if (errorFile) {
								logger("tempalteToModal error", errorFile);
								return Promise.reject(errorFile);
							}

							openFile(this.app, file);
						}
					).open();
				} else {
					const mode = context?.options?.config?.mode || "insert";
					const title = getTitleFromPath(templatePath);
					// console.log("Inserting", this, title)
					this.insertGeneratedText(text, editor, cursor, mode, title);
				}
			}
		).open();
		logger("tempalteToModal end");
	}

	getMetadata(path: string) {
		logger("getMetadata");
		const metadata = this.getFrontmatter(path);
		const validedMetaData: any = {};

		if (metadata?.PromptInfo?.promptId) {
			validedMetaData["id"] = metadata.PromptInfo.promptId;
		}

		if (metadata?.PromptInfo?.name) {
			validedMetaData["name"] = metadata.PromptInfo.name;
		}

		if (metadata?.PromptInfo?.description) {
			validedMetaData["description"] = metadata.PromptInfo.description;
		}

		if (metadata?.PromptInfo?.required_values) {
			validedMetaData["required_values"] =
				metadata.PromptInfo.required_values;
		}

		if (metadata?.PromptInfo?.author) {
			validedMetaData["author"] = metadata.PromptInfo.author;
		}

		if (metadata?.PromptInfo?.tags) {
			validedMetaData["tags"] = metadata.PromptInfo.tags;
		}

		if (metadata?.PromptInfo?.version) {
			validedMetaData["version"] = metadata.PromptInfo.version;
		}

		if (metadata?.PromptInfo?.commands) {
			validedMetaData["commands"] = metadata.PromptInfo.commands;
		}

		logger("getMetadata end");
		return validedMetaData;
	}

	getFrontmatter(path: string = "") {
		logger("getFrontmatter");
		const cache = this.app.metadataCache.getCache(path);
		if (cache.hasOwnProperty("frontmatter")) {
			logger("getFrontmatter end");
			return cache.frontmatter;
		}
		logger("getFrontmatter end");
		return null;
	}
}
