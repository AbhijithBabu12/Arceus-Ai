// @ts-nocheck
const vscode = require("vscode");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");

const STORAGE_KEY = "localAiAssistant.chatState";
const DEFAULT_OLLAMA_BASE_URL = "http://127.0.0.1:11434";
const DEFAULT_MODEL = "qwen2.5-coder:1.5b";
const MAX_HISTORY_MESSAGES = 12;
const MAX_WORKSPACE_FILES = 1200;
const MAX_SEMANTIC_FILES = 600;
const MAX_SEMANTIC_CHUNKS = 900;
const SEMANTIC_BATCH_SIZE = 12;
const CODE_EXTENSIONS = new Set([
    ".py", ".js", ".ts", ".tsx", ".jsx", ".html", ".css", ".json", ".java",
    ".c", ".cpp", ".h", ".hpp", ".go", ".rs", ".sh", ".md", ".txt", ".csv",
    ".sql", ".yaml", ".yml", ".toml", ".xml", ".php", ".rb", ".cs", ".kt"
]);
const IGNORED_DIRS = new Set([
    "node_modules", ".git", ".vscode", "__pycache__", "dist", "build", "out",
    ".next", ".turbo", "coverage", ".venv", "venv", "env"
]);

function escapeRegExp(text) {
    return String(text).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function extractMentions(text) {
    return [...String(text || "").matchAll(/@([^\s@]+)/g)]
        .map((match) => match[1].trim().replace(/[),.;:!?]+$/, ""))
        .filter(Boolean);
}

function extensionToLanguage(filePath) {
    const ext = path.extname(filePath || "").toLowerCase();
    return {
        ".py": "python",
        ".js": "javascript",
        ".ts": "typescript",
        ".tsx": "tsx",
        ".jsx": "jsx",
        ".html": "html",
        ".css": "css",
        ".json": "json",
        ".md": "markdown",
        ".java": "java",
        ".c": "c",
        ".cpp": "cpp",
        ".go": "go",
        ".rs": "rust",
        ".sh": "bash"
    }[ext] || ext.replace(".", "") || "text";
}

function resolveWorkspaceFile(relativePath) {
    const root = getWorkspaceRoot();
    if (!root || !relativePath) {
        return null;
    }

    const direct = path.resolve(root, relativePath);
    if (isInsideWorkspace(direct) && fs.existsSync(direct) && fs.statSync(direct).isFile()) {
        return direct;
    }

    const normalized = relativePath.replace(/\\/g, "/").toLowerCase();
    const byRelativePath = listWorkspaceFiles().find((file) => file.toLowerCase() === normalized);
    if (byRelativePath) {
        return path.resolve(root, byRelativePath);
    }

    const byName = listWorkspaceFiles().find((file) => path.basename(file).toLowerCase() === normalized);
    return byName ? path.resolve(root, byName) : null;
}

function buildMentionContext(input) {
    const mentions = extractMentions(input);
    if (!mentions.length) {
        return "";
    }

    const chunks = [];
    for (const mention of mentions) {
        const fullPath = resolveWorkspaceFile(mention);
        if (!fullPath) {
            chunks.push(`\nMentioned file @${mention} was not found in the current workspace.`);
            continue;
        }

        const root = getWorkspaceRoot();
        const relative = path.relative(root, fullPath).replace(/\\/g, "/");
        const language = extensionToLanguage(relative);
        const content = fs.readFileSync(fullPath, "utf8").slice(0, 20000);
        chunks.push(`\nExact content of @${relative}:\n\`\`\`${language}\n${content}\n\`\`\``);
    }

    return chunks.join("\n");
}

function getDefaultState() {
    return {
        chats: [],
        activeChatId: null,
        view: "home",
        settings: {
            model: DEFAULT_MODEL,
            mode: "auto"
        }
    };
}

function sanitizeState(state) {
    const fallback = getDefaultState();
    if (!state || typeof state !== "object") {
        return fallback;
    }

    return {
        chats: Array.isArray(state.chats) ? state.chats : [],
        activeChatId: typeof state.activeChatId === "string" ? state.activeChatId : null,
        view: state.view === "thread" ? "thread" : "home",
        settings: {
            model: state.settings?.model || fallback.settings.model,
            mode: state.settings?.mode || fallback.settings.mode
        }
    };
}

function mergeChatsById(localChats, diskChats) {
    const byId = new Map();

    for (const chat of [...localChats, ...diskChats]) {
        if (!chat || typeof chat.id !== "string") {
            continue;
        }

        const current = byId.get(chat.id);
        if (!current) {
            byId.set(chat.id, chat);
            continue;
        }

        const currentTime = new Date(current.updatedAt || current.createdAt || 0).getTime();
        const incomingTime = new Date(chat.updatedAt || chat.createdAt || 0).getTime();
        const currentMessages = Array.isArray(current.messages) ? current.messages.length : 0;
        const incomingMessages = Array.isArray(chat.messages) ? chat.messages.length : 0;

        if (incomingTime >= currentTime || incomingMessages > currentMessages) {
            byId.set(chat.id, {
                ...current,
                ...chat,
                messages: incomingMessages ? chat.messages : current.messages
            });
        }
    }

    return [...byId.values()].sort((a, b) => {
        const aTime = new Date(a.updatedAt || a.createdAt || 0).getTime();
        const bTime = new Date(b.updatedAt || b.createdAt || 0).getTime();
        return bTime - aTime;
    });
}

function encodeForScript(value) {
    return Buffer.from(JSON.stringify(value), "utf8").toString("base64");
}

function getWorkspaceRoot() {
    return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || "";
}

function isInsideWorkspace(filePath) {
    const root = getWorkspaceRoot();
    if (!root || !filePath) {
        return false;
    }

    const relative = path.relative(root, filePath);
    return relative && !relative.startsWith("..") && !path.isAbsolute(relative);
}

function listWorkspaceFiles() {
    const root = getWorkspaceRoot();
    if (!root || !fs.existsSync(root)) {
        return [];
    }

    const results = [];
    const walk = (dir) => {
        if (results.length >= MAX_WORKSPACE_FILES) {
            return;
        }

        let entries = [];
        try {
            entries = fs.readdirSync(dir, { withFileTypes: true });
        } catch {
            return;
        }

        for (const entry of entries) {
            if (results.length >= MAX_WORKSPACE_FILES) {
                break;
            }
            if (entry.name.startsWith(".") && entry.name !== ".env") {
                continue;
            }

            const fullPath = path.join(dir, entry.name);
            if (entry.isDirectory()) {
                if (!IGNORED_DIRS.has(entry.name)) {
                    walk(fullPath);
                }
                continue;
            }

            const ext = path.extname(entry.name).toLowerCase();
            if (!CODE_EXTENSIONS.has(ext)) {
                continue;
            }

            results.push(path.relative(root, fullPath).replace(/\\/g, "/"));
        }
    };

    walk(root);
    return results;
}

async function listOllamaModels() {
    const response = await fetch(`${getOllamaBaseUrl()}/api/tags`);
    if (!response.ok) {
        throw new Error(`Ollama returned ${response.status}`);
    }

    const data = await response.json();
    return Array.isArray(data.models)
        ? data.models
            .filter((model) => {
                const name = String(model.name || "");
                const families = Array.isArray(model.details?.families) ? model.details.families : [];
                const family = String(model.details?.family || "");
                return !/embed|embedding|bert/i.test(name)
                    && !/embed|embedding|bert/i.test(family)
                    && !families.some((item) => /embed|embedding|bert/i.test(String(item)));
            })
            .map((model) => model.name)
            .filter(Boolean)
        : [];
}

function getOllamaBaseUrl() {
    return vscode.workspace
        .getConfiguration("arceus")
        .get("ollamaBaseUrl", DEFAULT_OLLAMA_BASE_URL)
        .replace(/\/+$/, "");
}

function getDefaultModel() {
    return vscode.workspace
        .getConfiguration("arceus")
        .get("defaultModel", DEFAULT_MODEL);
}

function getKeepAlive() {
    return vscode.workspace
        .getConfiguration("arceus")
        .get("keepAlive", "10m");
}

function getNumCtx() {
    return vscode.workspace
        .getConfiguration("arceus")
        .get("numCtx", 4096);
}

function isSemanticSearchEnabled() {
    return vscode.workspace
        .getConfiguration("arceus")
        .get("semanticSearch.enabled", true);
}

function getEmbeddingModel() {
    return vscode.workspace
        .getConfiguration("arceus")
        .get("semanticSearch.embeddingModel", "nomic-embed-text");
}

function hashText(text) {
    return crypto.createHash("sha256").update(text).digest("hex");
}

function hashKey(text) {
    return crypto.createHash("sha1").update(text).digest("hex").slice(0, 16);
}

function normalizeVector(vector) {
    const magnitude = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0)) || 1;
    return vector.map((value) => value / magnitude);
}

function cosineSimilarity(a, b) {
    let score = 0;
    const length = Math.min(a.length, b.length);
    for (let i = 0; i < length; i++) {
        score += a[i] * b[i];
    }
    return score;
}

function chunkContent(content, relativePath) {
    const ext = path.extname(relativePath).toLowerCase();
    const lines = content.split(/\r?\n/);
    const chunks = [];
    let current = [];
    let startLine = 1;

    const boundary = (line) => {
        const trimmed = line.trim();
        if (ext === ".py") {
            return /^(async\s+def|def|class)\s+/.test(trimmed);
        }
        return /^(export\s+)?(async\s+)?function\s+|^(export\s+)?(class|const|let|var)\s+|^#{1,3}\s+/.test(trimmed);
    };

    const push = (endLine) => {
        const text = current.join("\n").trim();
        if (text.length >= 80) {
            chunks.push({ text: text.slice(0, 2500), startLine, endLine });
        }
        current = [];
    };

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (current.length && (boundary(line) || current.length >= 90)) {
            push(i);
            startLine = i + 1;
        }
        current.push(line);
    }

    if (current.length) {
        push(lines.length);
    }

    return chunks;
}

function shouldUseSemanticSearch(query) {
    const text = String(query || "").toLowerCase().trim();
    if (!text) {
        return false;
    }

    const words = text.split(/\s+/).filter(Boolean);
    if (words.length < 4) {
        return false;
    }

    if (/^(hi|hello|hey|yo|thanks|thank you|how are you|good morning|good evening)\b/.test(text)) {
        return false;
    }

    return /\b(file|project|workspace|code|function|class|component|bug|error|fix|implement|where|why|how|explain|review|debug|folder|module|import|api|route|backend|frontend|extension)\b/.test(text);
}

function withTimeout(promise, timeoutMs, fallback) {
    let timer;
    return Promise.race([
        promise,
        new Promise((resolve) => {
            timer = setTimeout(() => resolve(fallback), timeoutMs);
        })
    ]).finally(() => clearTimeout(timer));
}

async function embedTexts(model, inputs) {
    const response = await fetch(`${getOllamaBaseUrl()}/api/embed`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
            model,
            input: inputs,
            truncate: true,
            keep_alive: getKeepAlive()
        })
    });

    if (!response.ok) {
        throw new Error(`Embedding model unavailable (${response.status}). Run: ollama pull ${model}`);
    }

    const data = await response.json();
    return Array.isArray(data.embeddings) ? data.embeddings.map(normalizeVector) : [];
}

function buildSystemPrompt(mode, activeFile, semanticContext = "", mentionContext = "") {
    const modeHint = {
        auto: "Infer whether the user needs building, debugging, reviewing, explaining, or normal chat. Adapt your answer to that task.",
        build: "Build mode: focus on implementation. Give concrete steps, file-level guidance, and complete code when useful. Prefer practical patches over broad discussion.",
        debug: "Debug mode: identify likely root causes, ask for missing error details only when necessary, and give a focused fix path with checks.",
        review: "Review mode: lead with bugs, regressions, risks, and missing tests. Be specific and prioritize serious findings before style suggestions.",
        explain: "Explain mode: teach the code or concept clearly. Use examples and avoid making changes unless asked.",
        chat: "Chat mode: answer conversationally and concisely. Do not force codebase analysis unless the user asks."
    }[mode] || "Be a helpful local coding assistant.";

    const fileContext = activeFile?.content
        ? `\n\nActive file: ${activeFile.path}\n\`\`\`${activeFile.language || ""}\n${activeFile.content.slice(0, 8000)}\n\`\`\``
        : "";

    return [
        "You are Arceus, a local AI coding assistant inside VS Code.",
        "Be concise, practical, and honest. Prefer complete code when implementation is asked.",
        "Do not claim you edited files unless a tool or VS Code action actually did it.",
        "FILE RULE: When creating a file, the first line of the code block MUST be a comment with the filename. Example for Python: # filename: hello.py — Example for JS: // filename: app.js — Example for HTML: <!-- filename: index.html -->",
        "After writing code, ALWAYS provide a brief explanation of what the code does, how it works, and how to run or use it.",
        modeHint,
        mentionContext ? `\nMentioned file context. Use this exact content for @file questions and prioritize it over chat history:\n${mentionContext}` : "",
        semanticContext ? `\nRelevant workspace context from semantic search:\n${semanticContext}` : "",
        fileContext
    ].filter(Boolean).join("\n");
}

function buildOllamaMessages(payload) {
    const messages = Array.isArray(payload.messages) ? payload.messages : [];
    const mentionContext = buildMentionContext(payload.input || "");
    const hasMentions = extractMentions(payload.input || "").length > 0;
    const trimmed = messages
        .filter((message) => ["user", "assistant"].includes(message.role) && typeof message.content === "string")
        .slice(hasMentions ? -1 : -MAX_HISTORY_MESSAGES);

    return [
        { role: "system", content: buildSystemPrompt(payload.mode, payload.active_file, payload.semantic_context, mentionContext) },
        ...trimmed
    ];
}

function wantsAutomaticFileCreation(payload = {}) {
    if (payload.trust_mode === false) {
        return false;
    }

    const mode = String(payload.mode || "auto").toLowerCase();
    if (mode === "chat" || mode === "explain" || mode === "review") {
        return false;
    }

    const text = String(payload.input || "").toLowerCase();
    return /\b(create|make|write|generate|build|implement)\b/.test(text)
        && /\b(file|code|script|program|app|website|frontend|backend|[\w.-]+\.(py|js|ts|tsx|jsx|html|css|json|md|txt|csv|java|c|cpp|go|rs|sh))\b/.test(text);
}

function extractJsonObject(text) {
    const raw = String(text || "").trim().replace(/^```(?:json)?/i, "").replace(/```$/i, "").trim();
    try {
        return JSON.parse(raw);
    } catch {
        const match = raw.match(/\{[\s\S]*\}/);
        if (!match) {
            return null;
        }
        try {
            return JSON.parse(match[0]);
        } catch {
            return null;
        }
    }
}

function extractFilesFromMarkdown(text, userInput) {
    const files = [];
    // Match code blocks: ```lang filename\n...code...\n```
    // or code blocks with a filename comment on the first line
    const codeBlockRegex = /```(\w*)\s*([\w./\\-]*)\s*\n([\s\S]*?)```/g;
    let match;

    while ((match = codeBlockRegex.exec(text)) !== null) {
        const lang = match[1] || "";
        let name = (match[2] || "").trim();
        let code = (match[3] || "").trim();
        if (!code) continue;

        // Try to extract filename from first-line comment (e.g. # filename: calc.py)
        if (!name) {
            const firstLine = code.split("\n")[0];
            const fnMatch = firstLine.match(/^(?:#|\/\/|<!--|--)\s*filename:\s*(.+?)(?:\s*-->)?\s*$/i);
            if (fnMatch) {
                name = fnMatch[1].trim();
                code = code.split("\n").slice(1).join("\n").trim();
            }
        }

        // Infer filename from language and user input if still missing
        if (!name) {
            name = inferFileName(lang, userInput);
        }

        if (name && code) {
            files.push({ path: name, content: code });
        }
    }

    return files;
}

function inferFileName(lang, userInput) {
    const extMap = {
        python: ".py", py: ".py", javascript: ".js", js: ".js",
        typescript: ".ts", ts: ".ts", html: ".html", css: ".css",
        java: ".java", c: ".c", cpp: ".cpp", go: ".go",
        rust: ".rs", sh: ".sh", bash: ".sh", json: ".json",
        ruby: ".rb", php: ".php", sql: ".sql", xml: ".xml",
        yaml: ".yaml", yml: ".yaml", toml: ".toml", md: ".md",
        tsx: ".tsx", jsx: ".jsx", cs: ".cs", kt: ".kt"
    };

    const ext = extMap[lang.toLowerCase()] || ".py";
    const input = String(userInput || "").toLowerCase();

    // Try to extract a descriptive name from the user input
    // Remove trigger words and common filler
    const cleaned = input
        .replace(/\b(create|make|write|generate|build|implement|a|an|the|for|me|please|file|code|script|program)\b/g, "")
        .trim()
        .replace(/\s+/g, "_")
        .replace(/[^a-z0-9_]/g, "")
        .replace(/^_+|_+$/g, "");

    const baseName = cleaned || "main";
    return `${baseName}${ext}`;
}

function activate(context) {
    const activeRequests = new Map();

    class AIViewProvider {
        constructor(extensionContext) {
            this.context = extensionContext;
            this.view = null;
        }

        reply(webview, requestId, payload = {}) {
            webview.postMessage({ type: "extensionResponse", requestId, payload });
        }

        fail(webview, requestId, error) {
            webview.postMessage({
                type: "extensionError",
                requestId,
                payload: { message: String(error?.message || error || "Request failed") }
            });
        }

        async handleMessage(webview, message) {
            try {
                switch (message.type) {
                    case "ready":
                        await this.postState(webview);
                        break;
                    case "persistState":
                        {
                            const state = sanitizeState(message.payload);
                            await this.context.globalState.update(STORAGE_KEY, state);
                            this.saveChatsToDisk(state.chats);
                        }
                        break;
                    case "loadSavedChats": {
                        const chats = this.recoverChatsFromDisk();
                        webview.postMessage({
                            type: "savedChats",
                            payload: { chats }
                        });
                        break;
                    }
                    case "newChatFromCommand":
                        webview.postMessage({ type: "createChat" });
                        break;
                    case "expand":
                        vscode.commands.executeCommand("local-ai-assistant.expand");
                        break;
                    case "closePanel":
                        vscode.commands.executeCommand("workbench.action.toggleSidebarVisibility");
                        break;
                    case "getActiveFile":
                        this.postActiveFile(webview);
                        break;
                    case "applyCode":
                        await this.applyCode(message.payload?.code || "");
                        break;
                    case "createFile":
                        await this.createFileFromCode(message.payload?.code || "", message.payload?.defaultName || "");
                        break;
                    case "autoCreateFiles":
                        await this.autoCreateFiles(webview, message.payload?.blocks || []);
                        break;
                    case "listModels":
                        await this.handleListModels(webview, message.requestId);
                        break;
                    case "listFiles":
                        this.reply(webview, message.requestId, { files: listWorkspaceFiles() });
                        break;
                    case "setWorkspace":
                        this.reply(webview, message.requestId, { workspace: getWorkspaceRoot() });
                        break;
                    case "deleteChat":
                        await this.handleDeleteChat(webview, message.requestId, message.payload?.chatId);
                        break;
                    case "startVoice":
                        this.fail(webview, message.requestId, "Voice input is not available in the packaged extension yet.");
                        break;
                    case "stopVoice":
                        this.reply(webview, message.requestId, { text: "" });
                        break;
                    case "listJournal":
                        this.reply(webview, message.requestId, { tasks: [] });
                        break;
                    case "getJournalTask":
                        this.fail(webview, message.requestId, "Task journal is not available yet.");
                        break;
                    case "askOllama":
                        await this.handleAskOllama(webview, message.requestId, message.payload || {});
                        break;
                    case "cancelAsk":
                        this.cancelAsk(message.requestId);
                        break;
                    default:
                        break;
                }
            } catch (error) {
                if (message.requestId) {
                    this.fail(webview, message.requestId, error);
                } else {
                    vscode.window.showErrorMessage(String(error?.message || error));
                }
            }
        }

        postActiveFile(webview) {
            const editor = vscode.window.activeTextEditor;
            if (!editor) {
                webview.postMessage({ type: "activeFile", payload: null });
                return;
            }

            const doc = editor.document;
            const ext = path.extname(doc.fileName).toLowerCase();
            if (!CODE_EXTENSIONS.has(ext)) {
                webview.postMessage({ type: "activeFile", payload: null });
                return;
            }

            webview.postMessage({
                type: "activeFile",
                payload: {
                    path: doc.fileName,
                    content: doc.getText().slice(0, 8000),
                    language: doc.languageId
                }
            });
        }

        async applyCode(code) {
            const editor = vscode.window.activeTextEditor;
            if (!editor) {
                vscode.window.showErrorMessage("No active text editor found to apply code to.");
                return;
            }

            const success = await editor.edit(editBuilder => {
                if (!editor.selection.isEmpty) {
                    editBuilder.replace(editor.selection, code);
                } else {
                    editBuilder.insert(editor.selection.active, code);
                }
            });

            if (success) {
                vscode.commands.executeCommand("editor.action.formatDocument");
                vscode.window.showInformationMessage("Code applied to editor.");
            }
        }

        async createFileFromCode(code, defaultName = "") {
            const fileName = await vscode.window.showInputBox({
                prompt: "Enter the relative path/filename to create (e.g. src/index.js)",
                placeHolder: "index.js",
                value: defaultName,
                ignoreFocusOut: true
            });

            if (!fileName || !fileName.trim()) {
                return;
            }

            try {
                await this.writeFileToWorkspace(fileName.trim(), code);
            } catch (error) {
                vscode.window.showErrorMessage(`Failed to create file: ${error.message}`);
            }
        }

        async writeFileToWorkspace(fileName, code) {
            const rootPath = getWorkspaceRoot();
            if (!rootPath) {
                throw new Error("No open workspace found. Please open a folder in VS Code first.");
            }

            const safeName = String(fileName || "").trim().replace(/^[/\\]+/, "");
            if (!safeName) {
                throw new Error("No filename was provided.");
            }

            const fullPath = path.resolve(rootPath, safeName);

            if (!isInsideWorkspace(fullPath)) {
                throw new Error("Cannot create files outside the active workspace.");
            }

            const dir = path.dirname(fullPath);
            if (!fs.existsSync(dir)) {
                fs.mkdirSync(dir, { recursive: true });
            }

            fs.writeFileSync(fullPath, code, "utf8");

            const doc = await vscode.workspace.openTextDocument(fullPath);
            await vscode.window.showTextDocument(doc);
            this.notifyFilesChanged(this.view?.webview);
            return safeName;
            vscode.window.showInformationMessage(`✅ Created ${fileName}`);
        }

        async autoCreateFiles(webview, blocks) {
            if (!Array.isArray(blocks) || blocks.length === 0) {
                return;
            }

            const created = [];
            for (const block of blocks) {
                const { fileName, code } = block;
                if (!fileName || !code) {
                    continue;
                }

                try {
                    await this.writeFileToWorkspace(fileName, code);
                    created.push(fileName);
                } catch (error) {
                    vscode.window.showWarningMessage(`Failed to create ${fileName}: ${error.message}`);
                }
            }

            if (created.length > 0) {
                webview.postMessage({
                    type: "filesCreated",
                    payload: { files: created }
                });
            }
        }

        async handleAutomaticFileCreation(webview, requestId, payload) {
            const controller = new AbortController();
            activeRequests.set(requestId, controller);

            try {
                const response = await fetch(`${getOllamaBaseUrl()}/api/chat`, {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({
                        model: payload.model || getDefaultModel(),
                        messages: [
                            {
                                role: "system",
                                content: [
                                    "You are Arceus creating files inside a VS Code workspace.",
                                    "Return ONLY valid JSON with this exact schema:",
                                    '{"files":[{"path":"calculator.py","content":"# full code here"}],"summary":"Created calculator","run":"python calculator.py"}',
                                    "Rules:",
                                    "- Pick a clear filename. Use snake_case for Python.",
                                    "- Content must be complete runnable code.",
                                    "- No markdown fences, no explanation, just the JSON object."
                                ].join("\n")
                            },
                            { role: "user", content: payload.input || "" }
                        ],
                        stream: false,
                        keep_alive: getKeepAlive(),
                        options: { num_ctx: getNumCtx() }
                    }),
                    signal: controller.signal
                });

                if (!response.ok) {
                    throw new Error(`Ollama returned ${response.status}. Make sure Ollama is running and the model is pulled.`);
                }

                const data = await response.json();
                const rawContent = data?.message?.content || "";
                const parsed = extractJsonObject(rawContent);
                let files = Array.isArray(parsed?.files) ? parsed.files : [];

                // Fallback: if JSON parsing failed, extract code blocks from markdown
                if (!files.length) {
                    files = extractFilesFromMarkdown(rawContent, payload.input);
                }

                if (!files.length) {
                    throw new Error("The model did not return a valid file payload. Try again with a specific filename.");
                }

                const created = [];
                for (const file of files) {
                    const filePath = String(file.path || "").trim();
                    const content = String(file.content || "");
                    if (!filePath || !content.trim()) {
                        continue;
                    }
                    const createdPath = await this.writeFileToWorkspace(filePath, content);
                    created.push({ path: createdPath, content });
                }

                if (!created.length) {
                    throw new Error("No valid files were produced.");
                }

                const first = created[0];
                const language = extensionToLanguage(first.path);
                const summary = parsed?.summary || `Created ${created.map((file) => `\`${file.path}\``).join(", ")}.`;
                const run = parsed?.run ? `\n\nRun it with: \`${parsed.run}\`` : "";
                const text = [
                    summary,
                    "",
                    `Created file: \`${first.path}\``,
                    "",
                    `\`\`\`${language} ${first.path}`,
                    first.content,
                    "```",
                    run
                ].join("\n");

                webview.postMessage({ type: "askChunk", requestId, payload: { text } });
                webview.postMessage({ type: "filesCreated", payload: { files: created.map((file) => file.path) } });
                webview.postMessage({ type: "askDone", requestId, payload: { ok: true } });
            } catch (error) {
                const message = error?.name === "AbortError"
                    ? "Request stopped."
                    : String(error?.message || error || "Automatic file creation failed");
                webview.postMessage({ type: "askError", requestId, payload: { message } });
            } finally {
                activeRequests.delete(requestId);
            }
        }

        async handleListModels(webview, requestId) {
            try {
                this.reply(webview, requestId, { models: await listOllamaModels() });
            } catch {
                this.reply(webview, requestId, { models: [] });
            }
        }

        async handleDeleteChat(webview, requestId, chatId) {
            if (chatId) {
                const chatPath = this.getChatStoragePath(chatId);
                if (chatPath && fs.existsSync(chatPath)) {
                    fs.unlinkSync(chatPath);
                }
            }
            this.reply(webview, requestId, { ok: true });
        }

        getChatStorageDir() {
            const dir = path.join(this.context.globalStorageUri.fsPath, "chats");
            fs.mkdirSync(dir, { recursive: true });
            return dir;
        }

        getChatStoragePath(chatId) {
            const safeChatId = String(chatId || "")
                .replace(/[^a-zA-Z0-9_-]/g, "")
                .trim();
            if (!safeChatId) {
                return null;
            }
            return path.join(this.getChatStorageDir(), `${safeChatId}.json`);
        }

        saveChatsToDisk(chats) {
            if (!Array.isArray(chats)) {
                return;
            }

            const dir = this.getChatStorageDir();
            for (const chat of chats) {
                if (!chat?.id || !Array.isArray(chat.messages) || chat.messages.length === 0) {
                    continue;
                }

                const filePath = this.getChatStoragePath(chat.id);
                if (!filePath || !filePath.startsWith(dir)) {
                    continue;
                }

                fs.writeFileSync(filePath, JSON.stringify({
                    id: chat.id,
                    title: chat.title,
                    createdAt: chat.createdAt,
                    updatedAt: chat.updatedAt,
                    messages: chat.messages
                }, null, 2), "utf8");
            }
        }

        getSemanticIndexDir() {
            const dir = path.join(this.context.globalStorageUri.fsPath, "semantic-index");
            fs.mkdirSync(dir, { recursive: true });
            return dir;
        }

        getSemanticIndexPath() {
            const root = getWorkspaceRoot();
            const key = hashKey(`${root}:${getEmbeddingModel()}`);
            return path.join(this.getSemanticIndexDir(), `${key}.json`);
        }

        loadSemanticIndex() {
            const indexPath = this.getSemanticIndexPath();
            if (!fs.existsSync(indexPath)) {
                return null;
            }
            try {
                return JSON.parse(fs.readFileSync(indexPath, "utf8"));
            } catch {
                return null;
            }
        }

        saveSemanticIndex(index) {
            fs.writeFileSync(this.getSemanticIndexPath(), JSON.stringify(index), "utf8");
        }

        collectSemanticFiles() {
            const root = getWorkspaceRoot();
            if (!root || !fs.existsSync(root)) {
                return [];
            }

            return listWorkspaceFiles().slice(0, MAX_SEMANTIC_FILES).map((relativePath) => {
                const fullPath = path.join(root, relativePath);
                try {
                    const stat = fs.statSync(fullPath);
                    if (stat.size > 500_000) {
                        return null;
                    }
                    const content = fs.readFileSync(fullPath, "utf8");
                    return {
                        relativePath,
                        hash: hashText(content),
                        content
                    };
                } catch {
                    return null;
                }
            }).filter(Boolean);
        }

        async ensureSemanticIndex() {
            if (!isSemanticSearchEnabled()) {
                return null;
            }

            const root = getWorkspaceRoot();
            if (!root) {
                return null;
            }

            const model = getEmbeddingModel();
            const files = this.collectSemanticFiles();
            const hashes = Object.fromEntries(files.map((file) => [file.relativePath, file.hash]));
            const existing = this.loadSemanticIndex();

            if (
                existing?.workspace === root &&
                existing?.model === model &&
                JSON.stringify(existing.hashes || {}) === JSON.stringify(hashes) &&
                Array.isArray(existing.items) &&
                existing.items.length > 0
            ) {
                return existing;
            }

            const items = [];
            for (const file of files) {
                for (const chunk of chunkContent(file.content, file.relativePath)) {
                    if (items.length >= MAX_SEMANTIC_CHUNKS) {
                        break;
                    }
                    items.push({
                        file: file.relativePath,
                        startLine: chunk.startLine,
                        endLine: chunk.endLine,
                        text: chunk.text
                    });
                }
                if (items.length >= MAX_SEMANTIC_CHUNKS) {
                    break;
                }
            }

            if (!items.length) {
                return null;
            }

            const vectors = [];
            for (let i = 0; i < items.length; i += SEMANTIC_BATCH_SIZE) {
                const batch = items.slice(i, i + SEMANTIC_BATCH_SIZE);
                const embeddings = await embedTexts(model, batch.map((item) => item.text));
                vectors.push(...embeddings);
            }

            const index = {
                version: 1,
                workspace: root,
                model,
                updatedAt: new Date().toISOString(),
                hashes,
                items: items.map((item, index) => ({
                    ...item,
                    vector: vectors[index]
                })).filter((item) => Array.isArray(item.vector))
            };

            this.saveSemanticIndex(index);
            return index;
        }

        async getSemanticContext(query) {
            try {
                if (!shouldUseSemanticSearch(query)) {
                    return "";
                }

                const index = await this.ensureSemanticIndex();
                if (!index?.items?.length || !query?.trim()) {
                    return "";
                }

                const [queryVector] = await embedTexts(index.model, [query]);
                if (!queryVector) {
                    return "";
                }

                return index.items
                    .map((item) => ({
                        ...item,
                        score: cosineSimilarity(queryVector, item.vector)
                    }))
                    .sort((a, b) => b.score - a.score)
                    .slice(0, 5)
                    .map((item) => `File: ${item.file}:${item.startLine}\n---\n${item.text.slice(0, 1500)}`)
                    .join("\n\n");
            } catch (error) {
                console.warn("Semantic search skipped:", error?.message || error);
                return "";
            }
        }

        cancelAsk(requestId) {
            const controller = activeRequests.get(requestId);
            if (controller) {
                controller.abort();
                activeRequests.delete(requestId);
            }
        }

        async handleAskOllama(webview, requestId, payload) {
            if (wantsAutomaticFileCreation(payload)) {
                await this.handleAutomaticFileCreation(webview, requestId, payload);
                return;
            }

            const controller = new AbortController();
            activeRequests.set(requestId, controller);

            try {
                const semanticContext = await withTimeout(
                    this.getSemanticContext(payload.input || ""),
                    12000,
                    ""
                );
                if (!activeRequests.has(requestId)) {
                    const error = new Error("Request stopped.");
                    error.name = "AbortError";
                    throw error;
                }
                const response = await fetch(`${getOllamaBaseUrl()}/api/chat`, {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({
                        model: payload.model || getDefaultModel(),
                        messages: buildOllamaMessages({
                            ...payload,
                            semantic_context: semanticContext
                        }),
                        stream: true,
                        keep_alive: getKeepAlive(),
                        options: {
                            num_ctx: getNumCtx()
                        }
                    }),
                    signal: controller.signal
                });

                if (!response.ok || !response.body) {
                    throw new Error(`Ollama returned ${response.status}. Make sure Ollama is running and the model is pulled.`);
                }

                const reader = response.body.getReader();
                const decoder = new TextDecoder();
                let buffer = "";

                while (true) {
                    const { done, value } = await reader.read();
                    if (done) {
                        break;
                    }

                    buffer += decoder.decode(value, { stream: true });
                    const lines = buffer.split("\n");
                    buffer = lines.pop() || "";

                    for (const line of lines) {
                        if (!line.trim()) {
                            continue;
                        }
                        let event;
                        try {
                            event = JSON.parse(line);
                        } catch {
                            continue;
                        }
                        const text = event.message?.content || "";
                        if (text) {
                            webview.postMessage({ type: "askChunk", requestId, payload: { text } });
                        }
                        if (event.done) {
                            webview.postMessage({ type: "askDone", requestId, payload: { ok: true } });
                            activeRequests.delete(requestId);
                            return;
                        }
                    }
                }

                webview.postMessage({ type: "askDone", requestId, payload: { ok: true } });
            } catch (error) {
                const message = error?.name === "AbortError"
                    ? "Request stopped."
                    : String(error?.message || error || "Ollama request failed");
                webview.postMessage({ type: "askError", requestId, payload: { message } });
            } finally {
                activeRequests.delete(requestId);
            }
        }

        notifyFilesChanged(webview) {
            try {
                const files = listWorkspaceFiles();
                webview?.postMessage({ type: "filesChanged", payload: { files } });
            } catch { /* ignore */ }
        }

        resolveWebviewView(webviewView) {
            this.view = webviewView;

            webviewView.webview.options = {
                enableScripts: true,
                localResourceRoots: [
                    vscode.Uri.file(path.join(this.context.extensionPath, "media"))
                ]
            };

            webviewView.webview.onDidReceiveMessage((message) => {
                this.handleMessage(webviewView.webview, message);
            });

            try {
                webviewView.webview.html = this.getHtml(webviewView.webview);
            } catch (error) {
                webviewView.webview.html = this.getErrorHtml(error);
            }
        }

        async postState(webview = this.view?.webview) {
            const state = await this.getPersistedState();

            webview?.postMessage({
                type: "hydrate",
                payload: state
            });
        }

        async getPersistedState() {
            const state = sanitizeState(this.context.globalState.get(STORAGE_KEY));
            const recovered = this.recoverChatsFromDisk();
            if (recovered.length > 0) {
                state.chats = mergeChatsById(state.chats, recovered);
                if (!state.activeChatId || !state.chats.some(chat => chat.id === state.activeChatId)) {
                    state.activeChatId = state.chats[0]?.id || null;
                }
                if (state.view === "thread" && !state.activeChatId) {
                    state.view = "home";
                }
                await this.context.globalState.update(STORAGE_KEY, state);
            }

            return state;
        }

        recoverChatsFromDisk() {
            try {
                const workspaceFolders = vscode.workspace.workspaceFolders;
                const workspaceRoots = workspaceFolders?.map(folder => folder.uri.fsPath) || [];
                const candidates = [
                    this.getChatStorageDir(),
                    ...workspaceRoots.flatMap(rootPath => [
                        path.join(rootPath, "backend", "chats"),
                        path.join(rootPath, "chats"),
                        path.join(path.dirname(rootPath), "backend", "chats")
                    ]),
                    path.join(this.context.extensionPath, "..", "backend", "chats"),
                    path.join(this.context.extensionPath, "backend", "chats")
                ];
                const validDirs = [...new Set(candidates.filter(dir => fs.existsSync(dir)))];

                if (validDirs.length === 0) {
                    return [];
                }

                let allFiles = [];
                for (const dir of validDirs) {
                    try {
                        const files = fs.readdirSync(dir)
                            .filter(f => f.endsWith(".json"))
                            .map(f => {
                                const fullPath = path.join(dir, f);
                                return { name: f, mtime: fs.statSync(fullPath).mtimeMs, path: fullPath };
                            });
                        allFiles.push(...files);
                    } catch (e) {
                        continue;
                    }
                }
                
                const files = allFiles.sort((a, b) => b.mtime - a.mtime);

                const chats = [];
                for (const file of files) {
                    try {
                        const raw = fs.readFileSync(file.path, "utf-8");
                        const data = JSON.parse(raw);
                        const messages = data.messages || [];
                        if (messages.length === 0) continue;

                        const firstUser = messages.find(m => m.role === "user");
                        let title = firstUser ? firstUser.content.slice(0, 50).trim() : "New chat";
                        if (firstUser && firstUser.content.length > 50) title += "…";

                        const isoTime = new Date(file.mtime).toISOString();
                        chats.push({
                            id: file.name.replace(".json", ""),
                            title,
                            createdAt: isoTime,
                            updatedAt: isoTime,
                            messages: messages.map(m => ({
                                role: m.role,
                                content: m.content,
                                createdAt: isoTime
                            }))
                        });
                    } catch (e) {
                        continue; 
                    }
                }
                return chats;
            } catch (e) { 
                return []; 
            }
        }

        postMessage(message) {
            if (this.view) {
                this.view.webview.postMessage(message);
            }
        }

        getHtml(webview) {
            const htmlPath = path.join(this.context.extensionPath, "media", "index.html");
            let html = fs.readFileSync(htmlPath, "utf8");

            const scriptUri = webview.asWebviewUri(
                vscode.Uri.file(path.join(this.context.extensionPath, "media", "media.js"))
            ).with({ query: `v=${Date.now()}` });
            const hljsScript = webview.asWebviewUri(
                vscode.Uri.file(path.join(this.context.extensionPath, "media", "highlight.min.js"))
            );
            const hljsStyle = webview.asWebviewUri(
                vscode.Uri.file(path.join(this.context.extensionPath, "media", "highlight.min.css"))
            );

            html = html.replace(
                "</head>",
                `<link rel="stylesheet" href="${hljsStyle}">
<script src="${hljsScript}"></script>
</head>`
            );

            const workspaceFolders = vscode.workspace.workspaceFolders;
            const rootPath = workspaceFolders?.[0]?.uri.fsPath || "";
            const currentState = sanitizeState(this.context.globalState.get(STORAGE_KEY));
            const recoveredChats = this.recoverChatsFromDisk();
            const mergedChats = mergeChatsById(currentState.chats, recoveredChats);
            const bootState = sanitizeState({
                ...currentState,
                chats: mergedChats,
                activeChatId: mergedChats.length
                    ? (currentState.activeChatId && mergedChats.some(chat => chat.id === currentState.activeChatId)
                        ? currentState.activeChatId
                        : mergedChats[0]?.id || null)
                    : currentState.activeChatId,
                view: currentState.view === "thread" && mergedChats.length ? "thread" : "home"
            });

            html = html.replace(
                "</body>",
                `<script>
                window.__WORKSPACE_PATH__ = ${JSON.stringify(rootPath)};
                window.__ARCEUS_BOOT_STATE_B64__ = ${JSON.stringify(encodeForScript(bootState))};
                </script>
                <script src="${scriptUri}"></script>
                </body>`
            );

            return html;
        }

        getErrorHtml(error) {
            const message = String(error?.stack || error?.message || error)
                .replace(/&/g, "&amp;")
                .replace(/</g, "&lt;")
                .replace(/>/g, "&gt;");

            return `<!DOCTYPE html>
<html lang="en">
<body style="background:#1e1e1e;color:#e4e4e4;font:12px Consolas,monospace;padding:12px;white-space:pre-wrap;">
Arceus failed to load:

${message}
</body>
</html>`;
        }
    }

    const provider = new AIViewProvider(context);

    context.subscriptions.push(
        vscode.window.registerWebviewViewProvider(
            "local-ai-assistant.view",
            provider,
            {
                webviewOptions: {
                    retainContextWhenHidden: true
                }
            }
        )
    );

    context.subscriptions.push(
        vscode.commands.registerCommand("local-ai-assistant.newChat", async () => {
            await vscode.commands.executeCommand("local-ai-assistant.view.focus");
            provider.postMessage({ type: "createChat" });
        })
    );

    function setupPanel(panel) {
        try {
            panel.webview.html = provider.getHtml(panel.webview);
        } catch (error) {
            panel.webview.html = provider.getErrorHtml(error);
        }

        panel.webview.onDidReceiveMessage(async (message) => {
            await provider.handleMessage(panel.webview, message);
        });
    }

    // Expand: open Arceus in a split editor tab beside the current editor (right side)
    context.subscriptions.push(
        vscode.commands.registerCommand("local-ai-assistant.expand", () => {
            const panel = vscode.window.createWebviewPanel(
                "local-ai-assistant.editor",
                "Arceus",
                vscode.ViewColumn.Beside,
                {
                    enableScripts: true,
                    retainContextWhenHidden: true,
                    localResourceRoots: [
                        vscode.Uri.file(path.join(context.extensionPath, "media"))
                    ]
                }
            );

            setupPanel(panel);
        })
    );

    if (vscode.window.registerWebviewPanelSerializer) {
        vscode.window.registerWebviewPanelSerializer("local-ai-assistant.editor", {
            async deserializeWebviewPanel(webviewPanel, state) {
                webviewPanel.webview.options = {
                    enableScripts: true,
                    localResourceRoots: [
                        vscode.Uri.file(path.join(context.extensionPath, "media"))
                    ]
                };
                setupPanel(webviewPanel);
            }
        });
    }

    // File watcher: push live file list updates to the webview
    // so @ mentions always reflect the current workspace state
    let fileWatchDebounce = null;
    const watcher = vscode.workspace.createFileSystemWatcher("**/*");
    const notifyChange = () => {
        clearTimeout(fileWatchDebounce);
        fileWatchDebounce = setTimeout(() => {
            provider.notifyFilesChanged(provider.view?.webview);
        }, 500);
    };
    watcher.onDidCreate(notifyChange);
    watcher.onDidDelete(notifyChange);
    context.subscriptions.push(watcher);
}

function deactivate() {}

module.exports = {
    activate,
    deactivate
};
