# Arceus - Local AI Coding Assistant

Arceus is a powerful, fully local AI coding assistant for VS Code, powered by Ollama. It brings state-of-the-art AI capabilities directly into your editor, without sending any of your code to the cloud.

With a beautiful interface inspired by modern AI tools, Arceus streams responses directly from your local models, maintains your chat history, and deeply understands your codebase through active file context and local semantic search.

## ✨ Key Features

- **100% Local & Private:** Your code never leaves your machine. No internet connection required after downloading models. No API keys or subscriptions needed.
- **Frontend & App Building:** Ask Arceus to write entire frontends, construct UI components, or design complex algorithms from scratch.
- **Assisted Debugging:** Set the mode to **Debug** to let the assistant inspect error messages, pinpoint root causes, and outline a step-by-step resolution path.
- **One-Click Code Insertion:** Instantly insert or apply generated code blocks directly into your active editor or text selection with a single click.
- **Context-Aware Coding:** Arceus automatically reads your currently active file so it always knows what you're working on.
- **Workspace Semantic Search:** Automatically indexes your workspace using local embeddings (`nomic-embed-text`) to pull in relevant context from across your entire project when you ask a question.
- **Smart File Mentions:** Type `@` in the chat input to search and manually attach specific workspace files to your prompt.
- **Reasoning Model Support:** Built-in visualization for advanced models like DeepSeek-R1. Arceus elegantly captures and displays the AI's "Thinking" process in a collapsible block.
- **Specialized Chat Modes:** Quickly switch between tailored instructions: Auto, Build, Debug, Review, Explain, and Chat to get the best results for your specific task.
- **Persistent Chat History:** Your conversations are saved locally and seamlessly restored when you reload or reopen VS Code.
- **Flexible UI:** Use Arceus in the sidebar for quick questions, or expand it to a full editor panel for deep, focused coding sessions.

## 🚀 Getting Started

1. **Install Ollama:** Download and install Ollama from [https://ollama.com/](https://ollama.com/).
2. **Start Ollama:** Ensure the Ollama application is running on your machine.
3. **Pull Recommended Models:** Open your terminal and pull a coding model and an embedding model (for semantic search):
   ```bash
   ollama pull qwen2.5-coder:1.5b
   ollama pull nomic-embed-text
   ```
4. **Install Arceus:** Install the Arceus extension from the VS Code Marketplace.
5. **Start Chatting:** Click the Arceus icon in the Activity Bar, type your question, and hit enter!

*Optional: If you have a powerful machine, you can try larger models or reasoning models:*
```bash
ollama pull qwen2.5-coder:7b
ollama pull deepseek-r1:8b
```

## 💡 How to Use

- **Normal Chat:** Just start typing. Arceus will automatically use your current active file as context.
- **Ask About the Workspace:** Ask a broad question, and if Semantic Search is enabled, Arceus will find relevant code chunks across your open folder to answer it.
- **Include Specific Files:** Type `@` and start typing a filename to search your workspace. Select a file to attach its full contents to your message.
- **Change Modes:** Click the "Auto" button in the composer to switch between different AI behaviors (e.g., set to "Debug" when you need help fixing an error).

## ⚙️ Extension Settings

Customize Arceus via VS Code settings (`Ctrl+,` or `Cmd+,` and search for "Arceus"):

- `arceus.ollamaBaseUrl`: Your Ollama server URL (Default: `http://127.0.0.1:11434`).
- `arceus.defaultModel`: The default model loaded for new chats (Default: `qwen2.5-coder:1.5b`).
- `arceus.keepAlive`: How long Ollama keeps a model loaded in memory after a request (Default: `10m`).
- `arceus.numCtx`: Context window size. Increase if you are sending large files (Default: `4096`).
- `arceus.semanticSearch.enabled`: Enable/disable local semantic workspace search (Default: `true`).
- `arceus.semanticSearch.embeddingModel`: The model used to generate embeddings for search (Default: `nomic-embed-text`).

## 🔮 Future Roadmap

Features like voice input, automated task execution, and autonomous multi-file editing are actively being developed for future releases.
