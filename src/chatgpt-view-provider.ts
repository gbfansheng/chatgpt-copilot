/* eslint-disable @typescript-eslint/naming-convention */
/* eslint-disable eqeqeq */
/**
 * @author Ali Gençay
 * https://github.com/gencay/vscode-chatgpt
 *
 * @license
 * Copyright (c) 2022 - Present, Ali Gençay
 *
 * All rights reserved. Code licensed under the ISC license
 *
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.
 */

import delay from "delay";
import { ConversationChain, LLMChain } from "langchain/chains";
import { ChatOpenAI } from "langchain/chat_models/openai";
import { OpenAI } from "langchain/llms/openai";
import { BufferMemory } from "langchain/memory";
import {
  ChatPromptTemplate,
  HumanMessagePromptTemplate,
  MessagesPlaceholder,
  SystemMessagePromptTemplate,
} from "langchain/prompts";
import * as vscode from "vscode";

const logger = vscode.window.createOutputChannel("ChatGPT Copilot");

export default class ChatGptViewProvider implements vscode.WebviewViewProvider {
  private webView?: vscode.WebviewView;

  public subscribeToResponse: boolean;
  public autoScroll: boolean;
  public model?: string;
  private apiBaseUrl?: string;

  private apiCompletion?: OpenAI;
  private apiChat?: ChatOpenAI;
  private chain?: LLMChain;
  private conversationId?: string;
  private messageId?: string;
  private questionCounter: number = 0;
  private inProgress: boolean = false;
  private abortController?: AbortController;
  private currentMessageId: string = "";
  private response: string = "";

  /**
   * Message to be rendered lazily if they haven't been rendered
   * in time before resolveWebviewView is called.
   */
  private leftOverMessage?: any;
  constructor(private context: vscode.ExtensionContext) {
    this.subscribeToResponse =
      vscode.workspace
        .getConfiguration("chatgpt")
        .get("response.showNotification") || false;
    this.autoScroll = !!vscode.workspace
      .getConfiguration("chatgpt")
      .get("response.autoScroll");
    this.model = vscode.workspace
      .getConfiguration("chatgpt")
      .get("gpt3.model") as string;
    this.apiBaseUrl = vscode.workspace
      .getConfiguration("chatgpt")
      .get("gpt3.apiBaseUrl") as string;

    // Azure model names can't contain dots.
    if (this.apiBaseUrl?.includes("azure")) {
      this.model = this.model?.replace(".", "");
    }
  }

  public resolveWebviewView(
    webviewView: vscode.WebviewView,
    _context: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken,
  ) {
    this.webView = webviewView;

    webviewView.webview.options = {
      // Allow scripts in the webview
      enableScripts: true,

      localResourceRoots: [this.context.extensionUri],
    };

    webviewView.webview.html = this.getWebviewHtml(webviewView.webview);

    webviewView.webview.onDidReceiveMessage(async (data) => {
      switch (data.type) {
        case "addFreeTextQuestion":
          this.sendApiRequest(data.value, { command: "freeText" });
          break;
        case "editCode":
          const escapedString = (data.value as string).replace(/\$/g, "\\$");
          vscode.window.activeTextEditor?.insertSnippet(
            new vscode.SnippetString(escapedString),
          );

          this.logEvent("code-inserted");
          break;
        case "openNew":
          const document = await vscode.workspace.openTextDocument({
            content: data.value,
            language: data.language,
          });
          vscode.window.showTextDocument(document);

          this.logEvent(
            data.language === "markdown" ? "code-exported" : "code-opened",
          );
          break;
        case "clearConversation":
          this.messageId = undefined;
          this.conversationId = undefined;
          if (this.chain != null) {
            this.chain.memory = new BufferMemory({
              returnMessages: true,
              memoryKey: "history",
            });
          }
          this.logEvent("conversation-cleared");
          break;
        case "clearBrowser":
          this.logEvent("browser-cleared");
          break;
        case "cleargpt3":
          this.apiCompletion = undefined;
          this.logEvent("gpt3-cleared");
          break;
        case "login":
          this.prepareConversation().then((success) => {
            if (success) {
              this.sendMessage(
                {
                  type: "loginSuccessful",
                  showConversations: false,
                },
                true,
              );
              this.logEvent("logged-in");
            }
          });
          break;
        case "openSettings":
          vscode.commands.executeCommand(
            "workbench.action.openSettings",
            "@ext:feiskyer.chatgpt-copilot chatgpt.",
          );

          this.logEvent("settings-opened");
          break;
        case "openSettingsPrompt":
          vscode.commands.executeCommand(
            "workbench.action.openSettings",
            "@ext:feiskyer.chatgpt-copilot promptPrefix",
          );

          this.logEvent("settings-prompt-opened");
          break;
        case "listConversations":
          this.logEvent("conversations-list-attempted");
          break;
        case "showConversation":
          /// ...
          break;
        case "stopGenerating":
          this.stopGenerating();
          break;
        default:
          break;
      }
    });

    if (this.leftOverMessage != null) {
      // If there were any messages that wasn't delivered, render after resolveWebView is called.
      this.sendMessage(this.leftOverMessage);
      this.leftOverMessage = null;
    }
  }

  private stopGenerating(): void {
    this.abortController?.abort?.();
    this.inProgress = false;
    this.sendMessage({ type: "showInProgress", inProgress: this.inProgress });
    const responseInMarkdown = !this.isCodexModel;
    this.sendMessage({
      type: "addResponse",
      value: this.response,
      done: true,
      id: this.currentMessageId,
      autoScroll: this.autoScroll,
      responseInMarkdown,
    });
    this.logEvent("stopped-generating");
  }

  public clearSession(): void {
    this.stopGenerating();
    this.apiChat = undefined;
    this.apiCompletion = undefined;
    this.chain = undefined;
    this.conversationId = undefined;
    this.messageId = undefined;
    this.logEvent("cleared-session");
  }

  private get isCodexModel(): boolean {
    return !!this.model?.startsWith("code-");
  }

  private get isGpt35Model(): boolean {
    return !!this.model?.startsWith("gpt-");
  }

  public async prepareConversation(modelChanged = false): Promise<boolean> {
    const state = this.context.globalState;
    const configuration = vscode.workspace.getConfiguration("chatgpt");

    if (
      (this.isGpt35Model && !this.apiChat) ||
      (!this.isGpt35Model && !this.apiCompletion) ||
      modelChanged
    ) {
      let apiKey =
        (configuration.get("gpt3.apiKey") as string) ||
        (state.get("chatgpt-gpt3-apiKey") as string);
      const organization = configuration.get("gpt3.organization") as string;
      const maxTokens = configuration.get("gpt3.maxTokens") as number;
      const temperature = configuration.get("gpt3.temperature") as number;
      const topP = configuration.get("gpt3.top_p") as number;
      const apiBaseUrl = configuration.get("gpt3.apiBaseUrl") as string;

      if (!apiKey) {
        vscode.window
          .showErrorMessage(
            "Please add your API Key to use OpenAI official APIs. Storing the API Key in Settings is discouraged due to security reasons, though you can still opt-in to use it to persist it in settings. Instead you can also temporarily set the API Key one-time: You will need to re-enter after restarting the vs-code.",
            "Store in session (Recommended)",
            "Open settings",
          )
          .then(async (choice) => {
            if (choice === "Open settings") {
              vscode.commands.executeCommand(
                "workbench.action.openSettings",
                "chatgpt.gpt3.apiKey",
              );
              return false;
            } else if (choice === "Store in session (Recommended)") {
              await vscode.window
                .showInputBox({
                  title: "Store OpenAI API Key in session",
                  prompt:
                    "Please enter your OpenAI API Key to store in your session only. This option won't persist the token on your settings.json file. You may need to re-enter after restarting your VS-Code",
                  ignoreFocusOut: true,
                  placeHolder: "API Key",
                  value: apiKey || "",
                })
                .then((value) => {
                  if (value) {
                    apiKey = value;
                    state.update("chatgpt-gpt3-apiKey", apiKey);
                    this.sendMessage(
                      {
                        type: "loginSuccessful",
                      },
                      true,
                    );
                  }
                });
            }
          });

        return false;
      }

      const chatPrompt = ChatPromptTemplate.fromPromptMessages([
        SystemMessagePromptTemplate.fromTemplate(this.systemContext),
        new MessagesPlaceholder("history"),
        HumanMessagePromptTemplate.fromTemplate("{input}"),
      ]);
      var chatMemory = new BufferMemory({
        returnMessages: true,
        memoryKey: "history",
      });
      if (this.isGpt35Model) {
        if (apiBaseUrl?.includes("azure")) {
          // AzureOpenAI
          const instanceName = apiBaseUrl.split(".")[0].split("//")[1];
          const deployName =
            apiBaseUrl.split("/")[apiBaseUrl.split("/").length - 1];
          this.apiChat = new ChatOpenAI({
            modelName: this.model,
            azureOpenAIApiKey: apiKey,
            azureOpenAIApiInstanceName: instanceName,
            azureOpenAIApiDeploymentName: deployName,
            azureOpenAIApiCompletionsDeploymentName: deployName,
            azureOpenAIApiVersion: "2023-05-15",
            maxTokens: maxTokens,
            temperature: temperature,
            topP: topP,
          });
        } else {
          // OpenAI
          this.apiChat = new ChatOpenAI({
            openAIApiKey: apiKey,
            modelName: this.model,
            maxTokens: maxTokens,
            temperature: temperature,
            topP: topP,
            configuration: {
              baseURL: apiBaseUrl
            }
          });
        }

        this.chain = new ConversationChain({
          memory: chatMemory,
          prompt: chatPrompt,
          llm: this.apiChat,
        });
      } else {
        if (apiBaseUrl?.includes("azure")) {
          // AzureOpenAI
          const instanceName = apiBaseUrl.split(".")[0].split("//")[1];
          const deployName =
            apiBaseUrl.split("/")[apiBaseUrl.split("/").length - 1];
          this.apiCompletion = new OpenAI({
            modelName: this.model,
            azureOpenAIApiKey: apiKey,
            azureOpenAIApiInstanceName: instanceName,
            azureOpenAIApiDeploymentName: deployName,
            azureOpenAIApiCompletionsDeploymentName: deployName,
            azureOpenAIApiVersion: "2023-05-15",
            maxTokens: maxTokens,
            temperature: temperature,
            topP: topP,
          });
        } else {
          // OpenAI
          this.apiCompletion = new OpenAI({
            openAIApiKey: apiKey,
            modelName: this.model,
            maxTokens: maxTokens,
            temperature: temperature,
            topP: topP,
            configuration: {
              baseURL: apiBaseUrl
            }
          });
        }

        this.chain = new ConversationChain({
          memory: chatMemory,
          prompt: chatPrompt,
          llm: this.apiCompletion,
        });
      }
    }

    this.sendMessage({ type: "loginSuccessful" }, true);

    return true;
  }

  private get systemContext() {
    return `You are ChatGPT helping the User with coding.
			You are intelligent, helpful and an expert developer, who always gives the correct answer and only does what instructed. You always answer truthfully and don't make things up.
			(When responding to the following prompt, please make sure to properly style your response using Github Flavored Markdown.
			Use markdown syntax for things like headings, lists, colored text, code blocks, highlights etc. Make sure not to mention markdown or styling in your actual response.)`;
  }

  private processQuestion(question: string, code?: string, language?: string) {
    if (code != null) {
      // Add prompt prefix to the code if there was a code block selected
      question = `${question}${language
        ? ` (The following code is in ${language} programming language)`
        : ""
        }: ${code}`;
    }
    return question + "\r\n";
  }

  public async sendApiRequest(
    prompt: string,
    options: {
      command: string;
      code?: string;
      previousAnswer?: string;
      language?: string;
    },
  ) {
    if (this.inProgress) {
      // The AI is still thinking... Do not accept more questions.
      return;
    }

    this.questionCounter++;

    this.logEvent("api-request-sent", {
      "chatgpt.command": options.command,
      "chatgpt.hasCode": String(!!options.code),
      "chatgpt.hasPreviousAnswer": String(!!options.previousAnswer),
    });

    if (!(await this.prepareConversation())) {
      return;
    }

    this.response = "";
    let question = this.processQuestion(prompt, options.code, options.language);

    // If the ChatGPT view is not in focus/visible; focus on it to render Q&A
    if (this.webView == null) {
      vscode.commands.executeCommand("chatgpt-copilot.view.focus");
    } else {
      this.webView?.show?.(true);
    }

    this.inProgress = true;
    this.abortController = new AbortController();
    this.sendMessage({
      type: "showInProgress",
      inProgress: this.inProgress,
      showStopButton: true,
    });
    this.currentMessageId = this.getRandomId();

    this.sendMessage({
      type: "addQuestion",
      value: prompt,
      code: options.code,
      autoScroll: this.autoScroll,
    });

    const responseInMarkdown = !this.isCodexModel;
    const updateConsole = (message: string) => {
      this.sendMessage({
        type: "addResponse",
        value: message,
        messageId: this.conversationId,
        parentMessageId: this.messageId,
        autoScroll: this.autoScroll,
        responseInMarkdown,
      });
    };
    try {
      const gptResponse = await this.chain?.call(
        {
          input: question,
          // signal: this.abortController.signal,
        },
        [
          {
            handleLLMNewToken(token: string) {
              updateConsole(token);
            },
            handleLLMError(err, runId, parentRunId) {
              logger.appendLine(`Error in LLM: ${err.message}`);
            },
          },
        ],
      );
      this.response = gptResponse?.response;
      // this.sendMessage({
      //   type: "addResponse",
      //   value: this.response,
      //   autoScroll: this.autoScroll,
      //   messageId: this.conversationId,
      //   parentMessageId: this.messageId,
      //   responseInMarkdown,
      // });

      if (options.previousAnswer != null) {
        this.response = options.previousAnswer + this.response;
      }

      const hasContinuation = this.response.split("```").length % 2 === 0;

      if (hasContinuation) {
        this.response = this.response + " \r\n ```\r\n";
        vscode.window
          .showInformationMessage(
            "It looks like ChatGPT didn't complete their answer for your coding question. You can ask it to continue and combine the answers.",
            "Continue and combine answers",
          )
          .then(async (choice) => {
            if (choice === "Continue and combine answers") {
              this.sendApiRequest("Continue", {
                command: options.command,
                code: undefined,
                previousAnswer: this.response,
              });
            }
          });
      }

      this.sendMessage({
        type: "addResponse",
        value: this.response,
        done: true,
        id: this.currentMessageId,
        autoScroll: this.autoScroll,
        responseInMarkdown,
      });

      if (this.subscribeToResponse) {
        vscode.window
          .showInformationMessage(
            "ChatGPT responded to your question.",
            "Open conversation",
          )
          .then(async () => {
            await vscode.commands.executeCommand("chatgpt-copilot.view.focus");
          });
      }
    } catch (error: any) {
      let message;
      let apiMessage =
        error?.response?.data?.error?.message ||
        error?.tostring?.() ||
        error?.message ||
        error?.name;

      this.logError("api-request-failed");

      if (error?.response?.status || error?.response?.statusText) {
        message = `${error?.response?.status || ""} ${error?.response?.statusText || ""
          }`;

        vscode.window
          .showErrorMessage(
            "An error occured. If this is due to max_token you could try `ChatGPT: Clear Conversation` command and retry sending your prompt.",
            "Clear conversation and retry",
          )
          .then(async (choice) => {
            if (choice === "Clear conversation and retry") {
              await vscode.commands.executeCommand(
                "chatgpt-copilot.clearConversation",
              );
              await delay(250);
              this.sendApiRequest(prompt, {
                command: options.command,
                code: options.code,
              });
            }
          });
      } else if (error.statusCode === 400) {
        message = `Your model: '${this.model}' may be incompatible or one of your parameters is unknown. Reset your settings to default. (HTTP 400 Bad Request)`;
      } else if (error.statusCode === 401) {
        message =
          "Make sure you are properly signed in. If you are using Browser Auto-login method, make sure the browser is open (You could refresh the browser tab manually if you face any issues, too). If you stored your API key in settings.json, make sure it is accurate. If you stored API key in session, you can reset it with `ChatGPT: Reset session` command. (HTTP 401 Unauthorized) Potential reasons: \r\n- 1.Invalid Authentication\r\n- 2.Incorrect API key provided.\r\n- 3.Incorrect Organization provided. \r\n See https://platform.openai.com/docs/guides/error-codes for more details.";
      } else if (error.statusCode === 403) {
        message =
          "Your token has expired. Please try authenticating again. (HTTP 403 Forbidden)";
      } else if (error.statusCode === 404) {
        message = `Your model: '${this.model}' may be incompatible or you may have exhausted your ChatGPT subscription allowance. (HTTP 404 Not Found)`;
      } else if (error.statusCode === 429) {
        message =
          "Too many requests try again later. (HTTP 429 Too Many Requests) Potential reasons: \r\n 1. You exceeded your current quota, please check your plan and billing details\r\n 2. You are sending requests too quickly \r\n 3. The engine is currently overloaded, please try again later. \r\n See https://platform.openai.com/docs/guides/error-codes for more details.";
      } else if (error.statusCode === 500) {
        message =
          "The server had an error while processing your request, please try again. (HTTP 500 Internal Server Error)\r\n See https://platform.openai.com/docs/guides/error-codes for more details.";
      }

      if (apiMessage) {
        message = `${message ? message + " " : ""}

	${apiMessage}
`;
      }

      this.sendMessage({
        type: "addError",
        value: message,
        autoScroll: this.autoScroll,
      });

      return;
    } finally {
      this.inProgress = false;
      this.sendMessage({ type: "showInProgress", inProgress: this.inProgress });
    }
  }

  /**
   * Message sender, stores if a message cannot be delivered
   * @param message Message to be sent to WebView
   * @param ignoreMessageIfNullWebView We will ignore the command if webView is null/not-focused
   */
  public sendMessage(message: any, ignoreMessageIfNullWebView?: boolean) {
    if (this.webView) {
      this.webView?.webview.postMessage(message);
    } else if (!ignoreMessageIfNullWebView) {
      this.leftOverMessage = message;
    }
  }

  private logEvent(eventName: string, properties?: {}): void {
    // You can initialize your telemetry reporter and consume it here - *replaced with console.debug to prevent unwanted telemetry logs
    // this.reporter?.sendTelemetryEvent(eventName, { "chatgpt.loginMethod": this.loginMethod!, "chatgpt.authType": this.authType!, "chatgpt.model": this.model || "unknown", ...properties }, { "chatgpt.questionCounter": this.questionCounter });
    logger.appendLine(
      `INFO ${eventName} chatgpt.model:${this.model} chatgpt.questionCounter:${this.questionCounter
      } ${JSON.stringify(properties)}`,
    );
  }

  private logError(eventName: string): void {
    // You can initialize your telemetry reporter and consume it here - *replaced with console.error to prevent unwanted telemetry logs
    // this.reporter?.sendTelemetryErrorEvent(eventName, { "chatgpt.loginMethod": this.loginMethod!, "chatgpt.authType": this.authType!, "chatgpt.model": this.model || "unknown" }, { "chatgpt.questionCounter": this.questionCounter });
    logger.appendLine(
      `ERR ${eventName} chatgpt.model:${this.model} chatgpt.questionCounter:${this.questionCounter}}`,
    );
  }

  private getWebviewHtml(webview: vscode.Webview) {
    const scriptUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.context.extensionUri, "media", "main.js"),
    );
    const stylesMainUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.context.extensionUri, "media", "main.css"),
    );

    const vendorHighlightCss = webview.asWebviewUri(
      vscode.Uri.joinPath(
        this.context.extensionUri,
        "media",
        "vendor",
        "highlight.min.css",
      ),
    );
    const vendorHighlightJs = webview.asWebviewUri(
      vscode.Uri.joinPath(
        this.context.extensionUri,
        "media",
        "vendor",
        "highlight.min.js",
      ),
    );
    const vendorMarkedJs = webview.asWebviewUri(
      vscode.Uri.joinPath(
        this.context.extensionUri,
        "media",
        "vendor",
        "marked.min.js",
      ),
    );
    const vendorTailwindJs = webview.asWebviewUri(
      vscode.Uri.joinPath(
        this.context.extensionUri,
        "media",
        "vendor",
        "tailwindcss.3.2.4.min.js",
      ),
    );
    const vendorTurndownJs = webview.asWebviewUri(
      vscode.Uri.joinPath(
        this.context.extensionUri,
        "media",
        "vendor",
        "turndown.js",
      ),
    );

    const nonce = this.getRandomId();

    return `<!DOCTYPE html>
			<html lang="en">
			<head>
				<meta charset="UTF-8">
				<meta name="viewport" content="width=device-width, initial-scale=1.0">

				<link href="${stylesMainUri}" rel="stylesheet">
				<link href="${vendorHighlightCss}" rel="stylesheet">
				<script src="${vendorHighlightJs}"></script>
				<script src="${vendorMarkedJs}"></script>
				<script src="${vendorTailwindJs}"></script>
				<script src="${vendorTurndownJs}"></script>
			</head>
			<body class="overflow-hidden">
				<div class="flex flex-col h-screen">
					<div id="introduction" class="flex flex-col justify-between h-full justify-center px-6 w-full relative login-screen overflow-auto">
						<div class="flex items-start text-center features-block my-5">
							<div class="flex flex-col gap-3.5 flex-1">
								<svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="1.5" stroke="currentColor" aria-hidden="true" class="w-6 h-6 m-auto">
									<path stroke-linecap="round" stroke-linejoin="round" d="M3.75 13.5l10.5-11.25L12 10.5h8.25L9.75 21.75 12 13.5H3.75z"></path>
								</svg>
								<h2>Features</h2>
								<ul class="flex flex-col gap-3.5 text-xs">
									<li class="features-li w-full border border-zinc-700 p-3 rounded-md">Chat with your code and documents in conversations</li>
									<li class="features-li w-full border border-zinc-700 p-3 rounded-md">Improve your code, add tests & find bugs</li>
									<li class="features-li w-full border border-zinc-700 p-3 rounded-md">Copy or create new files automatically</li>
									<li class="features-li w-full border border-zinc-700 p-3 rounded-md">Syntax highlighting with auto language detection</li>
								</ul>
							</div>
						</div>
						<div class="flex flex-col gap-4 h-full items-center justify-end text-center">
							<p class="max-w-sm text-center text-xs text-slate-500">
								<a title="" id="settings-button" href="#">Update settings</a>&nbsp; | &nbsp;<a title="" id="settings-prompt-button" href="#">Update prompts</a>
							</p>
						</div>
					</div>

					<div class="flex-1 overflow-y-auto" id="qa-list"></div>

					<div class="flex-1 overflow-y-auto hidden" id="conversation-list"></div>

					<div id="in-progress" class="pl-4 pt-2 flex items-center hidden">
						<div class="typing">Thinking</div>
						<div class="spinner">
							<div class="bounce1"></div>
							<div class="bounce2"></div>
							<div class="bounce3"></div>
						</div>

						<button id="stop-button" class="btn btn-primary flex items-end p-1 pr-2 rounded-md ml-5">
							<svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="1.5" stroke="currentColor" class="w-5 h-5 mr-2"><path stroke-linecap="round" stroke-linejoin="round" d="M9.75 9.75l4.5 4.5m0-4.5l-4.5 4.5M21 12a9 9 0 11-18 0 9 9 0 0118 0z" /></svg>Stop responding</button>
					</div>

					<div class="p-4 flex items-center pt-2">
						<div class="flex-1 textarea-wrapper">
							<textarea
								type="text"
								rows="1"
								id="question-input"
								placeholder="Ask a question..."
								onInput="this.parentNode.dataset.replicatedValue = this.value"></textarea>
						</div>
						<div id="chat-button-wrapper" class="absolute bottom-14 items-center more-menu right-8 border border-gray-200 shadow-xl hidden text-xs">
							<button class="flex gap-2 items-center justify-start p-2 w-full" id="clear-button"><svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="1.5" stroke="currentColor" class="w-4 h-4"><path stroke-linecap="round" stroke-linejoin="round" d="M12 4.5v15m7.5-7.5h-15" /></svg>&nbsp;New chat</button>
							<button class="flex gap-2 items-center justify-start p-2 w-full" id="settings-button"><svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="1.5" stroke="currentColor" class="w-4 h-4"><path stroke-linecap="round" stroke-linejoin="round" d="M9.594 3.94c.09-.542.56-.94 1.11-.94h2.593c.55 0 1.02.398 1.11.94l.213 1.281c.063.374.313.686.645.87.074.04.147.083.22.127.324.196.72.257 1.075.124l1.217-.456a1.125 1.125 0 011.37.49l1.296 2.247a1.125 1.125 0 01-.26 1.431l-1.003.827c-.293.24-.438.613-.431.992a6.759 6.759 0 010 .255c-.007.378.138.75.43.99l1.005.828c.424.35.534.954.26 1.43l-1.298 2.247a1.125 1.125 0 01-1.369.491l-1.217-.456c-.355-.133-.75-.072-1.076.124a6.57 6.57 0 01-.22.128c-.331.183-.581.495-.644.869l-.213 1.28c-.09.543-.56.941-1.11.941h-2.594c-.55 0-1.02-.398-1.11-.94l-.213-1.281c-.062-.374-.312-.686-.644-.87a6.52 6.52 0 01-.22-.127c-.325-.196-.72-.257-1.076-.124l-1.217.456a1.125 1.125 0 01-1.369-.49l-1.297-2.247a1.125 1.125 0 01.26-1.431l1.004-.827c.292-.24.437-.613.43-.992a6.932 6.932 0 010-.255c.007-.378-.138-.75-.43-.99l-1.004-.828a1.125 1.125 0 01-.26-1.43l1.297-2.247a1.125 1.125 0 011.37-.491l1.216.456c.356.133.751.072 1.076-.124.072-.044.146-.087.22-.128.332-.183.582-.495.644-.869l.214-1.281z" /><path stroke-linecap="round" stroke-linejoin="round" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" /></svg>&nbsp;Update settings</button>
							<button class="flex gap-2 items-center justify-start p-2 w-full" id="export-button"><svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="1.5" stroke="currentColor" class="w-4 h-4"><path stroke-linecap="round" stroke-linejoin="round" d="M3 16.5v2.25A2.25 2.25 0 005.25 21h13.5A2.25 2.25 0 0021 18.75V16.5M16.5 12L12 16.5m0 0L7.5 12m4.5 4.5V3" /></svg>&nbsp;Export to markdown</button>
						</div>
						<div id="question-input-buttons" class="right-6 absolute p-0.5 ml-5 flex items-center gap-2">
							<button id="more-button" title="More actions" class="rounded-lg p-0.5">
								<svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="1.5" stroke="currentColor" class="w-5 h-5"><path stroke-linecap="round" stroke-linejoin="round" d="M12 6.75a.75.75 0 110-1.5.75.75 0 010 1.5zM12 12.75a.75.75 0 110-1.5.75.75 0 010 1.5zM12 18.75a.75.75 0 110-1.5.75.75 0 010 1.5z" /></svg>
							</button>

							<button id="ask-button" title="Submit prompt" class="ask-button rounded-lg p-0.5">
								<svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="1.5" stroke="currentColor" class="w-5 h-5"><path stroke-linecap="round" stroke-linejoin="round" d="M6 12L3.269 3.126A59.768 59.768 0 0121.485 12 59.77 59.77 0 013.27 20.876L5.999 12zm0 0h7.5" /></svg>
							</button>
						</div>
					</div>
				</div>

				<script nonce="${nonce}" src="${scriptUri}"></script>
			</body>
			</html>`;
  }

  private getRandomId() {
    let text = "";
    const possible =
      "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
    for (let i = 0; i < 32; i++) {
      text += possible.charAt(Math.floor(Math.random() * possible.length));
    }
    return text;
  }
}
