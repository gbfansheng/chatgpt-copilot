<h3 align="center"><img src="https://raw.githubusercontent.com/feiskyer/chatgpt-copilot/main/images/ai-logo.png" height="64"><br>An VS Code ChatGPT Copilot Extension</h3>

<p align="center">
    <a href="https://marketplace.visualstudio.com/items?itemName=feiskyer.chatgpt-copilot" alt="Marketplace version">
        <img src="https://img.shields.io/visual-studio-marketplace/v/feiskyer.chatgpt-copilot?color=orange&label=VS%20Code" />
    </a>
    <a href="https://marketplace.visualstudio.com/items?itemName=feiskyer.chatgpt-copilot" alt="Marketplace download count">
        <img src="https://img.shields.io/visual-studio-marketplace/d/feiskyer.chatgpt-copilot?color=blueviolet&label=Downloads" />
    </a>
    <a href="https://github.com/feiskyer/chatgpt-copilot" alt="Github star count">
        <img src="https://img.shields.io/github/stars/feiskyer/chatgpt-copilot?color=blue&label=Github%20Stars" />
    </a>
</p>

## The most loved opensourced ChatGPT extension for VS Code

The project is built on the most loved ChatGPT extension [gencay/vscode-chatgpt](https://github.com/gencay/vscode-chatgpt), which has downloaded by ~500,000 developers.

But unfortunately, the original author has decided to stop maintaining the project, and the new recommended Genie AI extension on the original project is not opensourced. So I decided to fork it and continue the development.

## Features

- ➕ Use GPT-4, GPT-3.5, GPT3 or Codex models using your API Key from OpenAI or Azure OpenAI Service
- 📃 Get streaming answers to your prompts in sidebar conversation window
- 🔥 Stop the responses to save your tokens.
- 📝 Create files or fix your code with one click or with keyboard shortcuts.
- ➡️ Export all your conversation history at once in Markdown format.
- Automatic partial code response detection. Continues and combines automatically, when response is cut off.
- Ad-hoc prompt prefixes for you to customize what you are asking ChatGPT
- Edit and resend a previous prompt
- Copy, insert or create new file from the code, ChatGPT is suggesting right into your editor.

## Configurations

| Configuration             | Description                                                                                                                                                                                   |
| ------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `chatgpt.gpt3.apiKey`     | Required to access OpenAI, please get one from OpenAI [here](https://platform.openai.com/account/api-keys).                                                                                   |
| `chatgpt.gpt3.apiBaseUrl` | Optional, default to `https://api.openai.com/v1`.<br>For Azure OpenAI Service, it should be set to `https://<YOUR-ENDPOINT-NAME>.openai.azure.com/openai/deployments/<YOUR-DEPLOYMENT-NAME>`. |
| `chatgpt.gpt3.model`      | Optional, default to `gpt-3.5-turbo`.                                                                                                                                                         |

## How to install locally

- Install `vsce` if you don't have it on your machine (The Visual Studio Code Extension Manager)
  - `npm install --global vsce`
- Run `vsce package`
- Follow the <a href="https://code.visualstudio.com/docs/editor/extension-marketplace#_install-from-a-vsix">instructions</a> and install manually.

## License

This project is released under ISC License - See [LICENSE](LICENSE) for details. Copyright notice and the respective permission notices must appear in all copies.
