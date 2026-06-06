// @ts-nocheck
const vscode = acquireVsCodeApi();
const DEFAULT_MODELS = [];

/* ── State ──────────────────────────────────── */
const state = {
  chats: [],
  activeChatId: null,
  view: "home",
  settings: { model: DEFAULT_MODELS[0], mode: "auto" },
  availableModels: [...DEFAULT_MODELS],
  workspaceFiles: [],
  isStreaming: false,
  mention: {
    active: false,
    query: "",
    startIndex: -1,
    selectedIndex: 0,
    filtered: [],
  },
};

let hasHydrated = false;
let abortController = null;
let streamingBodyEl = null;
let rafId = null;
let pendingDeleteId = null;
let isRefreshingModels = false;
let thinkStartTime = null;
let thinkDuration = null;
let userScrolledUp = false;
let nextRequestId = 1;
const pendingExtensionRequests = new Map();

function requestExtension(type, payload = {}, timeoutMs = 10000) {
  const requestId = `req-${nextRequestId++}`;
  vscode.postMessage({ type, requestId, payload });

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pendingExtensionRequests.delete(requestId);
      reject(new Error(`${type} timed out`));
    }, timeoutMs);

    pendingExtensionRequests.set(requestId, {
      resolve: (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      reject: (error) => {
        clearTimeout(timer);
        reject(error);
      },
    });
  });
}

/* ── SVG icons ──────────────────────────────── */
const SEND_ICON = `<svg width="14" height="14" viewBox="0 0 14 14" fill="none"><path d="M7 11V3M7 3L3.5 6.5M7 3l3.5 3.5" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
const STOP_ICON = `<svg width="10" height="10" viewBox="0 0 10 10" fill="none"><rect x="0.5" y="0.5" width="9" height="9" rx="2" fill="currentColor"/></svg>`;

/* ── DOM refs ───────────────────────────────── */
const $ = (id) => document.getElementById(id);
const elements = {
  homeView: $("homeView"),
  threadView: $("threadView"),
  chatList: $("chatList"),
  emptyState: $("emptyState"),
  conversation: $("conversation"),
  input: $("input"),
  sendBtn: $("sendBtn"),
  composer: document.querySelector(".composer"),
  newChatBtn: $("newChatBtn"),
  expandBtn: $("expandBtn"),
  backBtn: $("backBtn"),
  topbarHome: $("topbarHome"),
  topbarThread: $("topbarThread"),
  chatSubtitle: $("chatSubtitle"),
  bottomModeSelect: $("bottomModeSelect"),
  bottomModelSelect: $("bottomModelSelect"),
  modelPicker: $("modelPicker"),
  modelPickerBtn: $("modelPickerBtn"),
  modelPickerLabel: $("modelPickerLabel"),
  modelPickerMenu: $("modelPickerMenu"),
  modePicker: $("modePicker"),
  modePickerBtn: $("modePickerBtn"),
  modePickerLabel: $("modePickerLabel"),
  modePickerMenu: $("modePickerMenu"),
  refreshModelsBtn: $("refreshModelsBtn"),
  trustModeCheckbox: $("trustModeCheckbox"),
  mentionPopup: $("mentionPopup"),
  confirmOverlay: $("confirmOverlay"),
  confirmCancel: $("confirmCancel"),
  confirmOk: $("confirmOk"),
  micBtn: $("micBtn"),
  journalBtn: $("journalBtn"),
  journalView: $("journalView"),
  journalList: $("journalList"),
  journalDetailView: $("journalDetailView"),
  journalDetailContent: $("journalDetailContent"),
  closeJournalDetailBtn: $("closeJournalDetailBtn"),
};

/* ── Helpers ─────────────────────────────────── */
function makeId() {
  return `chat-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function nowIso() {
  return new Date().toISOString();
}

function getActiveChat() {
  return state.chats.find((c) => c.id === state.activeChatId) || null;
}

function buildTitle(text) {
  const clean = (text || "").replace(/\s+/g, " ").trim();
  if (!clean) return "New chat";
  const title = clean.split(" ").slice(0, 6).join(" ");
  return title.length > 34 ? `${title.slice(0, 31)}...` : title;
}

function buildPreview(chat) {
  const last = [...chat.messages].reverse().find((m) => m.content?.trim());
  if (!last) return "Start a conversation";
  const text = last.content.replace(/\s+/g, " ").trim();
  return text.length > 52 ? `${text.slice(0, 49)}...` : text;
}

function formatTime(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  const now = new Date();
  if (d.toDateString() === now.toDateString()) {
    return d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  }
  return d.toLocaleDateString([], { month: "short", day: "numeric" });
}

function sortChats() {
  state.chats.sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt));
}

function normalizeMessage(message, fallbackTime) {
  return {
    role: message?.role === "assistant" ? "assistant" : "user",
    content: typeof message?.content === "string" ? message.content : "",
    createdAt: message?.createdAt || fallbackTime || nowIso(),
  };
}

function normalizeChat(chat) {
  if (!chat || typeof chat !== "object" || typeof chat.id !== "string") {
    return null;
  }

  const createdAt = chat.createdAt || chat.updatedAt || nowIso();
  const updatedAt = chat.updatedAt || createdAt;
  const messages = Array.isArray(chat.messages)
    ? chat.messages.map((message) => normalizeMessage(message, updatedAt))
    : [];

  return {
    id: chat.id,
    title: chat.title || buildTitle(messages.find((m) => m.role === "user")?.content || ""),
    createdAt,
    updatedAt,
    messages,
  };
}

function normalizeSnapshot(snapshot) {
  if (!snapshot || typeof snapshot !== "object") return null;

  const chats = Array.isArray(snapshot.chats)
    ? snapshot.chats.map(normalizeChat).filter(Boolean)
    : [];
  const activeChatId = chats.some((chat) => chat.id === snapshot.activeChatId)
    ? snapshot.activeChatId
    : chats[0]?.id || null;

  return {
    chats,
    activeChatId,
    view: snapshot.view === "thread" && activeChatId ? "thread" : "home",
    settings: {
      model: snapshot.settings?.model || state.settings.model,
      mode: snapshot.settings?.mode || state.settings.mode,
    },
  };
}

function applySnapshot(snapshot) {
  const normalized = normalizeSnapshot(snapshot);
  if (!normalized) return false;

  state.chats = normalized.chats;
  state.activeChatId = normalized.activeChatId;
  state.view = normalized.view;
  state.settings = normalized.settings;
  ensureValidActiveChat();
  return true;
}

function snapshotHasChats(snapshot) {
  return Array.isArray(snapshot?.chats) && snapshot.chats.length > 0;
}

function snapshotHasRealChats(snapshot) {
  return Array.isArray(snapshot?.chats)
    && snapshot.chats.some((chat) => Array.isArray(chat?.messages) && chat.messages.length > 0);
}

function decodeBootState() {
  const encoded = window.__ARCEUS_BOOT_STATE_B64__;
  if (!encoded) return null;

  try {
    const bytes = Uint8Array.from(atob(encoded), (char) => char.charCodeAt(0));
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return null;
  }
}

function mergeChats(incomingChats) {
  const byId = new Map(state.chats.map((chat) => [chat.id, chat]));

  for (const incoming of incomingChats) {
    const current = byId.get(incoming.id);
    if (!current) {
      byId.set(incoming.id, incoming);
      continue;
    }

    const currentTime = new Date(current.updatedAt || 0).getTime();
    const incomingTime = new Date(incoming.updatedAt || 0).getTime();
    if (incomingTime >= currentTime || incoming.messages.length > current.messages.length) {
      byId.set(incoming.id, {
        ...current,
        ...incoming,
        messages: incoming.messages.length ? incoming.messages : current.messages,
      });
    }
  }

  state.chats = Array.from(byId.values());
}

function ensureValidActiveChat() {
  if (!state.chats.length) {
    state.activeChatId = null;
    state.view = "home";
    return;
  }

  if (!state.chats.some((chat) => chat.id === state.activeChatId)) {
    state.activeChatId = state.chats[0].id;
  }
}

function escapeHtml(t) {
  return String(t)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/* ── Persistence ─────────────────────────────── */
function persistState() {
  const payload = {
    chats: state.chats.map((c) => ({
      id: c.id,
      title: c.title,
      createdAt: c.createdAt,
      updatedAt: c.updatedAt,
      messages: c.messages.map((m) => ({
        role: m.role,
        content: m.content,
        createdAt: m.createdAt,
      })),
    })),
    activeChatId: state.activeChatId,
    view: state.view,
    settings: { model: state.settings.model, mode: state.settings.mode },
  };
  vscode.setState(payload);
  vscode.postMessage({ type: "persistState", payload });
}

async function hydrate(payload) {
  if (hasHydrated) return;
  hasHydrated = true;

  const cachedState = vscode.getState();
  const bootState = decodeBootState();
  const initialSnapshot = snapshotHasRealChats(bootState)
    ? bootState
    : snapshotHasRealChats(payload)
      ? payload
      : snapshotHasRealChats(cachedState)
        ? cachedState
        : snapshotHasChats(payload)
          ? payload
          : cachedState;
  applySnapshot(initialSnapshot);
  state.isStreaming = false;
  abortController = null;
  streamingBodyEl = null;
  render();
  vscode.postMessage({ type: "loadSavedChats" });
  syncControls();
  return;

  try {
    const data = { chats: [] };

    console.log("HYDRATE DATA:", data); // 👈 ADD THIS

    if (Array.isArray(data.chats) && data.chats.length > 0) {

      const previousActiveId = state.activeChatId;
      const previousView = state.view;
      mergeChats(data.chats.map(normalizeChat).filter(Boolean));
      state.activeChatId = previousActiveId || state.chats[0]?.id || null;
      state.view = previousView === "thread" && state.activeChatId ? "thread" : "home";
      ensureValidActiveChat();
      persistState();
      render();

    } else {
      ensureValidActiveChat();
    }

  } catch (e) {
    // Keep persisted VS Code state if recovery is unavailable during startup.
  }

  await loadModels();

  console.log("STATE AFTER HYDRATE:", state); // 👈 ADD THIS

  render();
}

function loadSavedChats(payload) {
  const diskChats = Array.isArray(payload?.chats)
    ? payload.chats.map(normalizeChat).filter(Boolean)
    : [];

  if (!diskChats.length) return;

  const previousActiveId = state.activeChatId;
  const previousView = state.view;
  const activeBeforeMerge = getActiveChat();
  const activeWasEmptyNewChat = activeBeforeMerge
    && activeBeforeMerge.messages.length === 0
    && activeBeforeMerge.title === "New chat";
  mergeChats(diskChats);
  state.activeChatId = activeWasEmptyNewChat
    ? diskChats[0]?.id || state.chats[0]?.id || null
    : previousActiveId || state.chats[0]?.id || null;
  state.view = activeWasEmptyNewChat
    ? "home"
    : previousView === "thread" && state.activeChatId ? "thread" : "home";
  ensureValidActiveChat();
  persistState();
  render();
}

async function loadModels() {
  try {
    const data = await requestExtension("listModels", {}, 5000);
    const models = Array.isArray(data.models)
      ? data.models.filter((model) => typeof model === "string"
        && model.trim()
        && !/(embed|embedding|bert)/i.test(model))
      : [];

    state.availableModels = models;
  } catch {
    state.availableModels = [];
  }

  if (!state.availableModels.includes(state.settings.model)) {
    state.settings.model = state.availableModels[0] || "";
    persistState();
  }
}

/* ── Chat operations ─────────────────────────── */
function ensureActiveChat(seed = "") {
  const active = getActiveChat();
  if (active) return active;
  return createChat(seed, false);
}

function createChat(seed = "", switchView = true) {
  const ts = nowIso();
  const chat = {
    id: makeId(),
    title: buildTitle(seed),
    createdAt: ts,
    updatedAt: ts,
    messages: [],
  };
  state.chats.unshift(chat);
  state.activeChatId = chat.id;
  state.view = switchView ? "thread" : "home";
  persistState();
  render();
  focusInput();
  return chat;
}

function openChat(id) {
  state.activeChatId = id;
  state.view = "thread";
  persistState();
  render();
}

function goHome() {
  state.view = "home";
  persistState();
  render();
}

function openJournal() {
  state.view = "journal";
  persistState();
  render();
  fetchJournalTasks();
}

/* ── Delete with confirmation ────────────────── */
function requestDelete(chatId) {
  const active = getActiveChat();
  if (state.isStreaming) {
    stopStreaming();
  }

  pendingDeleteId = chatId;
  elements.confirmOverlay.classList.remove("hidden")
}

function confirmDelete() {
  if (!pendingDeleteId) return;
  const chatId = pendingDeleteId;
  pendingDeleteId = null;
  elements.confirmOverlay.classList.add("hidden");

  requestExtension("deleteChat", { chatId }, 3000).catch(() => { });

  state.chats = state.chats.filter((c) => c.id !== chatId);
  if (state.activeChatId === chatId) {
    state.activeChatId = state.chats[0]?.id || null;
    if (!state.activeChatId) state.view = "home";
  }
  persistState();
  render();
}

function cancelDelete() {
  pendingDeleteId = null;
  elements.confirmOverlay.classList.add("hidden");
}

/* ── Rendering ───────────────────────────────── */
function render() {
  sortChats();
  renderChatList();
  renderActiveView();
  syncControls();
}

function renderModelOptions() {
  if (state.availableModels.length === 0) {
    elements.bottomModelSelect.innerHTML = `<option value="" disabled selected>No models found</option>`;
    return;
  }
  const optionsHtml = state.availableModels
    .map((model) => `<option value="${escapeHtml(model)}">${escapeHtml(model)}</option>`)
    .join("");

  elements.bottomModelSelect.innerHTML = optionsHtml;
}

function closePickers() {
  elements.modelPicker?.classList.remove("open");
  elements.modePicker?.classList.remove("open");
  elements.modelPickerMenu?.classList.add("hidden");
  elements.modePickerMenu?.classList.add("hidden");
}

function togglePicker(kind) {
  const shell = kind === "model" ? elements.modelPicker : elements.modePicker;
  const menu = kind === "model" ? elements.modelPickerMenu : elements.modePickerMenu;
  const wasOpen = shell.classList.contains("open");
  closePickers();
  if (!wasOpen) {
    shell.classList.add("open");
    menu.classList.remove("hidden");
    positionPickerMenu(shell, menu);
  }
}

function positionPickerMenu(shell, menu) {
  menu.style.left = "0px";
  const rect = menu.getBoundingClientRect();
  const margin = 8;
  if (rect.right > window.innerWidth - margin) {
    menu.style.left = `${Math.max(window.innerWidth - margin - rect.right, -rect.left + margin)}px`;
  }
}

function renderCustomPickers() {
  if (!elements.modelPickerMenu || !elements.modePickerMenu) return;

  elements.modelPickerLabel.textContent = state.settings.model || "No model";
  if (state.availableModels.length === 0) {
    elements.modelPickerMenu.innerHTML = `<div class="picker-title">Model</div>
      <div class="picker-empty">No models found. Install models with:<br><code>ollama pull &lt;model&gt;</code></div>`;
    elements.modelPickerMenu.style.setProperty("--picker-min-width", "220px");
  } else {
    elements.modelPickerMenu.innerHTML = `<div class="picker-title">Model</div>` +
      state.availableModels.map((model) => `
        <button class="picker-option${model === state.settings.model ? " active" : ""}" data-pick-model="${escapeHtml(model)}" type="button">
          <span class="option-name">${escapeHtml(model)}</span>
        </button>
      `).join("");
    const longestModel = state.availableModels.reduce((longest, model) =>
      model.length > longest.length ? model : longest, state.settings.model || "");
    elements.modelPickerMenu.style.setProperty("--picker-min-width", `${Math.min(Math.max(190, longestModel.length * 7 + 34), 340)}px`);
  }

  const modes = [
    ["auto", "Auto"],
    ["build", "Build"],
    ["debug", "Debug"],
    ["review", "Review"],
    ["explain", "Explain"],
    ["chat", "Chat"],
  ];
  const currentMode = modes.find(([value]) => value === state.settings.mode)?.[1] || "Auto";
  elements.modePickerLabel.textContent = currentMode;
  elements.modePickerMenu.innerHTML = `<div class="picker-title">Mode</div>` +
    modes.map(([value, label]) => `
      <button class="picker-option${value === state.settings.mode ? " active" : ""}" data-pick-mode="${value}" type="button">
        <span class="option-name">${label}</span>
      </button>
    `).join("");
  elements.modePickerMenu.style.setProperty("--picker-min-width", "132px");
}

function renderChatList() {
  elements.chatList.innerHTML = "";

  for (const chat of state.chats) {
    const item = document.createElement("div");
    item.className = `chat-item${chat.id === state.activeChatId ? " active" : ""}`;
    item.innerHTML = `
      <div class="chat-row">
        <div class="chat-title">${escapeHtml(chat.title)}</div>
        <div class="chat-time">${escapeHtml(formatTime(chat.updatedAt))}</div>
      </div>
      <div class="chat-row">
        <div class="chat-preview">${escapeHtml(buildPreview(chat))}</div>
        <button class="delete-btn" data-delete-chat="${chat.id}" title="Delete">
          <svg width="11" height="11" viewBox="0 0 12 12" fill="none"><path d="M2.5 2.5l7 7M9.5 2.5l-7 7" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>
        </button>
      </div>
    `;
    item.addEventListener("click", (e) => {
      if (e.target.closest("[data-delete-chat]")) return;
      openChat(chat.id);
    });
    elements.chatList.appendChild(item);
  }

  elements.emptyState.style.display = state.chats.length ? "none" : "flex";
}

const welcomeHtml = `
  <div class="welcome-msg">
    <p class="intro">How can I help you today?</p>
    <p>Ask me anything — I'll use your locally installed Ollama models to assist.</p>
  </div>
`;

function renderActiveView() {
  const showThread = state.view === "thread" && getActiveChat();
  const showJournal = state.view === "journal";
  const showHome = state.view === "home" || (!showThread && !showJournal);

  // Toggle views
  elements.homeView.classList.toggle("hidden", !showHome);
  elements.threadView.classList.toggle("hidden", !showThread);
  elements.journalView.classList.toggle("hidden", !showJournal);

  // Toggle topbar content
  elements.topbarHome.classList.toggle("hidden", showThread);
  elements.topbarThread.classList.toggle("hidden", !showThread);

  if (showJournal) {
    streamingBodyEl = null;
    return;
  }

  if (!showThread) {
    streamingBodyEl = null;
    return;
  }

  const chat = getActiveChat();
  elements.chatSubtitle.textContent = chat.title;

  elements.conversation.innerHTML = chat.messages.length
    ? chat.messages.map(renderMessage).join("")
    : welcomeHtml;

  highlightCompleted(elements.conversation);

  if (state.isStreaming && chat.messages.length > 0) {
    const lastMsg = chat.messages[chat.messages.length - 1];
    if (lastMsg.streaming) {
      streamingBodyEl =
        elements.conversation.querySelector(
          ".message:last-child .message-body"
        );
    } else {
      streamingBodyEl = null;
    }
  } else {
    streamingBodyEl = null;
  }
}

function renderMessage(msg) {
  let body;
  if (msg.streaming && !msg.content) {
    body = '<span class="typing-dots"><span></span><span></span><span></span></span>';
  } else {
    body = buildMessageHtml(msg.content || "", !!msg.streaming, msg.thinkDuration);
  }
  return `<article class="message ${msg.role}"><div class="message-body">${body}</div></article>`;
}

function highlightCompleted(root) {
  root.querySelectorAll("pre code").forEach((block) => {
    if (window.hljs && !block.closest(".streaming-code")) {
      window.hljs.highlightElement(block);
    }
  });
}

/* ── Thinking block parser ───────────── */
function parseThinkingAndAnswer(text) {
  const t = text.trimStart();

  // Find ALL complete <think>...</think> blocks
  const thinkRegex = /<think>([\s\S]*?)<\/think>/g;
  let thinkingParts = [];
  let match;
  let lastEnd = 0;

  while ((match = thinkRegex.exec(t)) !== null) {
    thinkingParts.push(match[1].trim());
    lastEnd = match.index + match[0].length;
  }

  if (thinkingParts.length > 0) {
    // We found complete thinking blocks
    const answer = t.slice(lastEnd).trim();

    // Check if there's another unclosed <think> after the last closed one
    const remaining = t.slice(lastEnd);
    const unclosed = remaining.match(/<think>([\s\S]*)$/);
    if (unclosed) {
      thinkingParts.push(unclosed[1]);
      return { thinking: thinkingParts.join("\n\n"), answer: "", stillThinking: true };
    }

    return { thinking: thinkingParts.join("\n\n"), answer, stillThinking: false };
  }

  // Check for a single unclosed <think> (still streaming)
  const unclosed = t.match(/^<think>([\s\S]*)$/);
  if (unclosed) {
    return { thinking: unclosed[1], answer: "", stillThinking: true };
  }

  // No thinking blocks at all
  return { thinking: null, answer: text, stillThinking: false };
}

function extractPhaseStepperHtml(text) {
  if (!text) return "";
  const p1 = text.includes("Phase 1: Planning");
  const p2 = text.includes("Phase 2: Execution");
  const p3 = text.includes("Phase 3: Reviewing");
  const p4 = text.includes("Phase 4: Repairing");

  if (!p1 && !p2 && !p3 && !p4) return "";

  let active = 1;
  if (p4) active = 4;
  else if (p3) active = 3;
  else if (p2) active = 2;
  else if (p1) active = 1;

  const steps = [
    { num: 1, label: "Plan", icon: "📝" },
    { num: 2, label: "Execute", icon: "⚡" },
    { num: 3, label: "Review", icon: "🔍" },
    { num: 4, label: "Repair", icon: "🔧" }
  ];

  const visibleSteps = p4 ? steps : steps.slice(0, 3);

  let html = `<div class="phase-stepper">`;
  visibleSteps.forEach((s, i) => {
    let statusClass = "";
    if (s.num === active) statusClass = "active";
    else if (s.num < active) statusClass = "done";

    html += `
      <div class="phase-step ${statusClass}">
        <span class="phase-icon">${s.icon}</span>
        ${s.label}
      </div>
    `;
    if (i < visibleSteps.length - 1) {
      html += `<div class="phase-divider">→</div>`;
    }
  });
  html += `</div>`;

  return html;
}

function renderThinkingBlock(thinkContent, stillThinking, isStreaming, duration) {
  const dotClass = stillThinking ? "thinking-dot" : "thinking-dot done";
  let label;
  if (stillThinking) {
    // Show elapsed time if available
    if (thinkStartTime) {
      const elapsed = Math.round((Date.now() - thinkStartTime) / 1000);
      label = `Thinking… ${elapsed}s`;
    } else {
      label = "Thinking…";
    }
  } else if (duration && duration > 0) {
    label = `Thought for ${duration}s`;
  } else {
    label = "Thought";
  }
  // NEVER auto-open. User can click to expand if they want to see thoughts.
  const streamClass = stillThinking ? "streaming" : "";
  const safeContent = thinkContent ? formatResponse(thinkContent, !!isStreaming) : "";
  const phaseStepper = extractPhaseStepperHtml(thinkContent);
  return `<details class="thinking-block ${streamClass}">
    <summary class="thinking-summary">
      <span class="thinking-caret">▶</span>
      <span class="thinking-label">${label}</span>
      <span class="${dotClass}"></span>
    </summary>
    <div class="thinking-content">
      ${phaseStepper}
      ${safeContent || '<span class="typing-dots"><span></span><span></span><span></span></span>'}
    </div>
  </details>`;
}

function buildMessageHtml(content, isStreaming, duration) {
  if (!content) {
    return '<span class="typing-dots"><span></span><span></span><span></span></span>';
  }
  const { thinking, answer, stillThinking } = parseThinkingAndAnswer(content);
  let html = "";
  if (thinking !== null) {
    html += renderThinkingBlock(thinking, stillThinking, isStreaming, duration);
  }
  if (answer) {
    html += formatResponse(answer, isStreaming);
  } else if (stillThinking && isStreaming) {
    // Still thinking, no answer yet — show waiting indicator below the thinking block
    html += '<p class="thinking-wait"><span class="typing-dots"><span></span><span></span><span></span></span></p>';
  } else if (isStreaming && thinking !== null && !answer && !stillThinking) {
    // Thinking done, waiting for answer tokens
    html += '<span class="typing-dots"><span></span><span></span><span></span></span>';
  }
  return html || '<span class="typing-dots"><span></span><span></span><span></span></span>';
}

/* ── Targeted streaming update (no flicker, preserves DOM state) ── */
function scheduleStreamingUpdate(content, duration) {
  if (rafId) cancelAnimationFrame(rafId);
  rafId = requestAnimationFrame(() => {
    if (!streamingBodyEl) { rafId = null; return; }

    const { thinking, answer, stillThinking } = parseThinkingAndAnswer(content);

    // ── Phase 1: Still thinking — show live thinking in compact block ──
    if (stillThinking) {
      let thinkBlock = streamingBodyEl.querySelector('.thinking-block');
      let thinkContent = streamingBodyEl.querySelector('.thinking-content');

      if (!thinkBlock) {
        // First time: create the live thinking block (open by default)
        streamingBodyEl.innerHTML = `
          <details class="thinking-block streaming" open>
            <summary class="thinking-summary">
              <span class="thinking-caret">▶</span>
              <span class="thinking-label">Thinking for 0s</span>
              <span class="thinking-dot"></span>
            </summary>
            <div class="thinking-content"></div>
          </details>
          <div class="answer-content"><span class="typing-dots"><span></span><span></span><span></span></span></div>
        `;
        thinkBlock = streamingBodyEl.querySelector('.thinking-block');
        thinkContent = streamingBodyEl.querySelector('.thinking-content');
      }

      // Update the timer in the summary (don't touch the rest)
      const elapsed = thinkStartTime ? Math.round((Date.now() - thinkStartTime) / 1000) : 0;
      const label = thinkBlock.querySelector('.thinking-label');
      if (label) label.textContent = `Thinking for ${elapsed}s`;

      // Update thinking content
      if (thinkContent && thinking) {
        const phaseStepper = extractPhaseStepperHtml(thinking);
        thinkContent.innerHTML = phaseStepper + formatResponse(thinking, true);
        // Auto-scroll the thinking content to the bottom
        thinkContent.scrollTop = thinkContent.scrollHeight;
      }
    }
    // ── Phase 2: Thinking done, answer streaming ─────────────────
    else if (thinking !== null) {
      let thinkBlock = streamingBodyEl.querySelector('.thinking-block');
      let answerDiv = streamingBodyEl.querySelector('.answer-content');

      if (!thinkBlock) {
        // No existing block (shouldn't happen, but handle gracefully)
        const dur = duration || 0;
        const phaseStepper = extractPhaseStepperHtml(thinking);
        const thinkHtml = thinking ? formatResponse(thinking, false) : '';
        streamingBodyEl.innerHTML = `
          <details class="thinking-block">
            <summary class="thinking-summary">
              <span class="thinking-caret">▶</span>
              <span class="thinking-label">Thought for ${dur}s</span>
              <span class="thinking-dot done"></span>
            </summary>
            <div class="thinking-content">
              ${phaseStepper}
              ${thinkHtml}
            </div>
          </details>
          <div class="answer-content"></div>
        `;
        thinkBlock = streamingBodyEl.querySelector('.thinking-block');
        answerDiv = streamingBodyEl.querySelector('.answer-content');
      } else if (thinkBlock.classList.contains('streaming')) {
        // Transition: thinking just ended — update in-place
        thinkBlock.classList.remove('streaming');
        thinkBlock.removeAttribute('open'); // collapse it
        const dur = duration || 0;
        const label = thinkBlock.querySelector('.thinking-label');
        if (label) label.textContent = `Thought for ${dur}s`;
        const dot = thinkBlock.querySelector('.thinking-dot');
        if (dot) dot.classList.add('done');
        // Final thinking content
        const tc = thinkBlock.querySelector('.thinking-content');
        if (tc && thinking) {
          const phaseStepper = extractPhaseStepperHtml(thinking);
          tc.innerHTML = phaseStepper + formatResponse(thinking, false);
        }
      }

      // Only update the answer — never touch the thinking block
      if (answerDiv) {
        if (answer) {
          answerDiv.innerHTML = formatResponse(answer, true);
          highlightCompleted(answerDiv);
        } else {
          answerDiv.innerHTML = '<span class="typing-dots"><span></span><span></span><span></span></span>';
        }
      }
    }
    // ── Phase 3: No thinking at all — plain text streaming ───────
    else {
      // For non-thinking models, use a simple answer div
      let answerDiv = streamingBodyEl.querySelector('.answer-content');
      if (!answerDiv) {
        streamingBodyEl.innerHTML = '<div class="answer-content"></div>';
        answerDiv = streamingBodyEl.querySelector('.answer-content');
      }
      answerDiv.innerHTML = formatResponse(content, true);
      highlightCompleted(answerDiv);
    }

    if (!userScrolledUp) {
      scrollConversation();
    }
    rafId = null;
  });
}

/* ── Controls ────────────────────────────────── */
function syncControls() {
  renderModelOptions();
  elements.bottomModelSelect.value = state.settings.model;
  elements.bottomModeSelect.value = state.settings.mode;
  const modeLabels = {
    auto: "Auto: choose the best response style",
    build: "Build: implementation-focused answers",
    debug: "Debug: root cause and fix path",
    review: "Review: bugs, risks, and tests first",
    explain: "Explain: teach the code or concept",
    chat: "Chat: concise general conversation",
  };
  elements.bottomModeSelect.title = modeLabels[state.settings.mode] || "Response mode";
  elements.modelPickerBtn.title = `Chat model: ${state.settings.model}`;
  elements.modePickerBtn.title = modeLabels[state.settings.mode] || "Response mode";
  renderCustomPickers();
  elements.refreshModelsBtn.classList.toggle("loading", isRefreshingModels);
  elements.refreshModelsBtn.title = isRefreshingModels ? "Reloading models..." : "Reload models";
  updateSendButton();
}

function updateSendButton() {
  if (state.isStreaming) {
    elements.sendBtn.innerHTML = STOP_ICON;
    elements.sendBtn.classList.add("stop-mode");
    elements.sendBtn.title = "Stop";
    elements.sendBtn.disabled = false;
  } else {
    elements.sendBtn.innerHTML = SEND_ICON;
    elements.sendBtn.classList.remove("stop-mode");
    elements.sendBtn.title = "Send";
    elements.sendBtn.disabled = false;
  }
}

function focusInput() {
  elements.input.focus();
}

function autoResize() {
  elements.input.style.height = "auto";
  elements.input.style.height = `${Math.min(elements.input.scrollHeight, 110)}px`;
}

function scrollConversation(force = false) {
  const el = elements.conversation;
  if (!el) return;
  const gap = el.scrollHeight - el.scrollTop - el.clientHeight;
  if (force) {
    userScrolledUp = false;
    el.scrollTop = el.scrollHeight;
  } else if (!userScrolledUp && gap < 120) {
    el.scrollTop = el.scrollHeight;
  }
}

// Extracts filename from a code block's first comment line.
// Handles many real-world model output patterns including:
//   # filename: x, // filename: x, # file: x, # x.py, # x.py:1, etc.
// Returns { fileName, cleanCode } or null.
function extractFilenameFromCode(codeText) {
  const lines = codeText.split("\n");
  if (lines.length === 0) return null;

  const first = lines[0].trim();
  const FILE_EXT = /\.[a-zA-Z0-9]{1,10}$/;

  // Strip trailing line numbers like ":1" or ": 1"
  function cleanName(raw) {
    return raw.trim().replace(/:\s*\d+\s*$/, "").trim();
  }

  // Validate: must look like a real file path (has extension, no spaces in name)
  function isValid(name) {
    return name && FILE_EXT.test(name) && !/\s/.test(name) && name.length < 200;
  }

  // 1) Explicit keyword patterns: # filename: x, // file: x, etc.
  const keywordPatterns = [
    /^#\s*(?:filename|filepath|file)\s*:\s*(.+)$/i,
    /^\/\/\s*(?:filename|filepath|file)\s*:\s*(.+)$/i,
    /^\/\*\s*(?:filename|filepath|file)\s*:\s*(.+?)\s*\*\/$/i,
    /^<!--\s*(?:filename|filepath|file)\s*:\s*(.+?)\s*-->$/i,
  ];

  for (const rx of keywordPatterns) {
    const m = first.match(rx);
    if (m) {
      const name = cleanName(m[1]);
      if (isValid(name)) {
        return { fileName: name, cleanCode: lines.slice(1).join("\n") };
      }
    }
  }

  // 2) Bare filename as comment: # hello.py, // app.js, /* style.css */, <!-- index.html -->
  const barePatterns = [
    /^#\s*(.+)$/,
    /^\/\/\s*(.+)$/,
    /^\/\*\s*(.+?)\s*\*\/$/,
    /^<!--\s*(.+?)\s*-->$/,
  ];

  for (const rx of barePatterns) {
    const m = first.match(rx);
    if (m) {
      const name = cleanName(m[1]);
      if (isValid(name)) {
        return { fileName: name, cleanCode: lines.slice(1).join("\n") };
      }
    }
  }

  return null;
}

// Tries to extract a filename from the code fence language line.
// e.g., "python fibonacci.py" -> "fibonacci.py"
function extractFilenameFromLang(lang) {
  if (!lang) return null;
  const parts = lang.trim().split(/\s+/);
  if (parts.length >= 2) {
    const candidate = parts.slice(1).join("").trim();
    if (candidate && /\.[a-zA-Z0-9]{1,10}$/.test(candidate) && !/\s/.test(candidate)) {
      return candidate;
    }
  }
  return null;
}
function formatResponse(text, isStreaming = false) {
  const parts = text.split(/```/);
  let html = "";

  for (let i = 0; i < parts.length; i++) {
    if (i % 2 === 0) {
      html += formatTextPart(parts[i]);
      continue;
    }

    const lines = parts[i].split("\n");
    const lang = (lines[0] || "").trim() || "code";
    const code = lines.slice(1).join("\n").trimEnd();
    const isIncomplete =
      isStreaming && i === parts.length - 1 && parts.length % 2 === 0;

    if (isIncomplete) {
      html += `
        <div class="code-container streaming-code">
          <div class="code-header"><span>${escapeHtml(lang)}</span></div>
          <pre><code class="language-${escapeHtml(lang)}">${escapeHtml(code)}</code></pre>
        </div>`;
    } else if (lang.startsWith("diff:")) {
      const filename = lang.split(":")[1] || "File";
      let diffHtml = "";
      const diffLines = code.split("\n");
      for (const l of diffLines) {
        if (l.startsWith("+")) {
          diffHtml += `<div class="diff-line diff-added">${escapeHtml(l)}</div>`;
        } else if (l.startsWith("-")) {
          diffHtml += `<div class="diff-line diff-removed">${escapeHtml(l)}</div>`;
        } else if (l.startsWith("@@")) {
          diffHtml += `<div class="diff-line diff-header-line">${escapeHtml(l)}</div>`;
        } else {
          diffHtml += `<div class="diff-line diff-context">${escapeHtml(l)}</div>`;
        }
      }

      const safePath = encodeURIComponent(filename);
      html += `
        <div class="diff-block">
          <div class="diff-header">
            <span class="diff-filename">${escapeHtml(filename)}</span>
            <div class="diff-actions">
              <button class="diff-reject" data-reject-diff="${safePath}">Reject</button>
              <button class="diff-accept" data-accept-diff="${safePath}">Accept Change</button>
            </div>
          </div>
          <div class="diff-content">${diffHtml}</div>
        </div>`;
    } else {
      const extracted = extractFilenameFromCode(code);
      const langFileName = !extracted ? extractFilenameFromLang(lang) : null;
      const detectedName = extracted?.fileName || langFileName || null;
      const btnLabel = detectedName ? `Create ${detectedName}` : "Create File";
      const safe = encodeURIComponent(code);
      html += `
        <div class="code-container">
          <div class="code-header">
            <span>${escapeHtml(lang)}</span>
            <div class="code-actions">
              <button class="create-file-btn" data-create-file="${safe}">${escapeHtml(btnLabel)}</button>
              <button class="apply-btn" data-apply="${safe}">Apply to Editor</button>
              <button class="copy-btn" data-copy="${safe}">Copy</button>
            </div>
          </div>
          <pre><code class="language-${escapeHtml(lang)}">${escapeHtml(code)}</code></pre>
        </div>`;
    }
  }

  return html;
}

/**
 * Renders plain-text markdown (outside code fences) into HTML.
 * Handles headings (#-###), unordered/ordered lists, bold, inline code.
 */
function formatTextPart(text) {
  const escaped = escapeHtml(text.trim());
  if (!escaped) return "";

  const lines = escaped.split("\n");
  let html = "";
  let i = 0;

  while (i < lines.length) {
    const trimmed = lines[i].trim();

    if (!trimmed) {
      i++;
      continue;
    }

    // Headings → render as bold paragraph
    const hMatch = trimmed.match(/^(#{1,6})\s+(.+)$/);
    if (hMatch) {
      html += `<p><strong>${formatInline(hMatch[2])}</strong></p>`;
      i++;
      continue;
    }

    // Unordered list
    if (/^[-*]\s/.test(trimmed)) {
      html += "<ul>";
      while (i < lines.length && /^[-*]\s/.test(lines[i].trim())) {
        const itemText = lines[i].trim().replace(/^[-*]\s+/, "");
        html += `<li>${formatInline(itemText)}</li>`;
        i++;
      }
      html += "</ul>";
      continue;
    }

    // Ordered list
    if (/^\d+\.\s/.test(trimmed)) {
      html += "<ol>";
      while (i < lines.length && /^\d+\.\s/.test(lines[i].trim())) {
        const itemText = lines[i].trim().replace(/^\d+\.\s+/, "");
        html += `<li>${formatInline(itemText)}</li>`;
        i++;
      }
      html += "</ol>";
      continue;
    }

    // Regular paragraph
    let para = "";
    while (i < lines.length) {
      const l = lines[i].trim();
      if (!l) { i++; break; }
      if (/^#{1,6}\s/.test(l) || /^[-*]\s/.test(l) || /^\d+\.\s/.test(l)) break;
      para += (para ? "<br>" : "") + formatInline(l);
      i++;
    }
    if (para) html += `<p>${para}</p>`;
  }

  return html;
}

function formatInline(text) {
  let r = text;
  r = r.replace(/`([^`]+)`/g, '<span class="inline-code">$1</span>');
  r = r.replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");
  r = r.replace(/\[ACTION:([^|]+)\|([^\]]+)\]/g, '<button class="action-btn" data-action="$1">$2</button>');
  return r;
}

/* ── Send / Stop ─────────────────────────────── */
async function sendRequest() {
  const input = elements.input.value.trim();
  if (!input || state.isStreaming) return;

  const chat = ensureActiveChat(input);
  if (chat.title === "New chat") chat.title = buildTitle(input);
  state.view = "thread";

  const userMsg = { role: "user", content: input, createdAt: nowIso() };
  const asstMsg = {
    role: "assistant",
    content: "",
    createdAt: nowIso(),
    streaming: true,
  };

  chat.messages.push(userMsg, asstMsg);
  chat.updatedAt = nowIso();
  state.isStreaming = true;
  thinkStartTime = null;
  thinkDuration = null;
  userScrolledUp = false;
  elements.input.value = "";
  autoResize();
  persistState();
  render();
  scrollConversation(true);

  // Fetch active file from extension host (non-blocking, 200ms timeout)
  let activeFile = null;
  try {
    activeFile = await new Promise((resolve) => {
      const handler = (e) => {
        if (e.data?.type === "activeFile") {
          window.removeEventListener("message", handler);
          resolve(e.data.payload);
        }
      };
      window.addEventListener("message", handler);
      vscode.postMessage({ type: "getActiveFile" });
      setTimeout(() => { window.removeEventListener("message", handler); resolve(null); }, 200);
    });
  } catch { activeFile = null; }

  const requestId = `ask-${nextRequestId++}`;
  abortController = {
    abort() {
      const err = new Error("Aborted");
      err.name = "AbortError";
      const pending = pendingExtensionRequests.get(requestId);
      if (pending) {
        pendingExtensionRequests.delete(requestId);
        pending.reject(err);
      }
      vscode.postMessage({ type: "cancelAsk", requestId });
    },
  };

  try {
    await new Promise((resolve, reject) => {
      let wasThinking = false;
      pendingExtensionRequests.set(requestId, {
        resolve,
        reject,
        onChunk: (chunk) => {
          asstMsg.content += chunk;
          const { stillThinking, thinking } = parseThinkingAndAnswer(asstMsg.content);
          if (thinking !== null && !thinkStartTime) {
            thinkStartTime = Date.now();
          }
          if (wasThinking && !stillThinking && thinkStartTime && !thinkDuration) {
            thinkDuration = Math.round((Date.now() - thinkStartTime) / 1000);
          }
          wasThinking = stillThinking;
          scheduleStreamingUpdate(asstMsg.content, thinkDuration);
        },
      });

      vscode.postMessage({
        type: "askOllama",
        requestId,
        payload: {
          messages: chat.messages
            .filter((message) => !message.streaming)
            .map((message) => ({ role: message.role, content: message.content })),
          input,
          model: state.settings.model,
          mode: state.settings.mode,
          trust_mode: elements.trustModeCheckbox.checked,
          chat_id: chat.id,
          workspace: window.__WORKSPACE_PATH__,
          active_file: activeFile,
        },
      });
    });

    asstMsg.content = asstMsg.content.trim();
  } catch (err) {
    if (err.name === "AbortError") {
      asstMsg.content = asstMsg.content.trim() || "(Stopped)";
    } else {
      const message = err.message === "Failed to fetch"
        ? "Ollama is not reachable. Install Ollama, start it, and pull a model like qwen2.5-coder:1.5b."
        : err.message;
      asstMsg.content = `Error: ${message}`;
    }
  } finally {
    pendingExtensionRequests.delete(requestId);
    delete asstMsg.streaming;
    // Store thinking duration on the message for re-rendering
    if (thinkDuration) {
      asstMsg.thinkDuration = thinkDuration;
    }
    chat.updatedAt = nowIso();
    state.isStreaming = false;
    abortController = null;
    streamingBodyEl = null;
    thinkStartTime = null;
    thinkDuration = null;
    userScrolledUp = false;
    if (rafId) {
      cancelAnimationFrame(rafId);
      rafId = null;
    }
    persistState();
    render();
    scrollConversation(true);
    focusInput();

    // Auto-create files if Trust mode is on
    if (elements.trustModeCheckbox.checked) {
      autoCreateFromResponse(asstMsg.content);
    }
  }
}

/**
 * Parses the completed AI response for code blocks with filename comments.
 * If Trust mode is on, sends them to the extension host for automatic creation.
 */
function autoCreateFromResponse(responseText) {
  if (!responseText) return;
  if (/^Created file:\s*`[^`]+`/m.test(responseText)) return;

  const parts = responseText.split(/```/);
  const blocks = [];

  for (let i = 1; i < parts.length; i += 2) {
    const segment = parts[i];
    if (!segment) continue;
    const lines = segment.split("\n");
    const lang = (lines[0] || "").trim();
    const code = lines.slice(1).join("\n").trimEnd();
    if (!code) continue;

    const extracted = extractFilenameFromCode(code);
    if (extracted && extracted.fileName && extracted.cleanCode) {
      blocks.push({
        fileName: extracted.fileName,
        code: extracted.cleanCode
      });
    } else {
      // Fallback: try to get filename from the language line
      const langName = extractFilenameFromLang(lang);
      if (langName) {
        blocks.push({ fileName: langName, code });
      }
    }
  }

  if (blocks.length > 0) {
    vscode.postMessage({
      type: "autoCreateFiles",
      payload: { blocks }
    });
  }
}

async function loadFiles() {
  try {
    const data = await requestExtension("listFiles", {}, 10000);
    state.workspaceFiles = Array.isArray(data.files) ? data.files : [];
    if (state.mention.active) {
      state.mention.filtered = state.workspaceFiles
        .filter(f => f.toLowerCase().includes((state.mention.query || "").toLowerCase()))
        .slice(0, 100);
      state.mention.selectedIndex = 0;
      updateMentionPopup();
    }
  } catch (err) {
    console.error("Failed to load workspace files", err);
  }
}
function updateMentionPopup() {
  const { mentionPopup } = elements;
  if (!state.mention.active || state.mention.filtered.length === 0) {
    mentionPopup.classList.add("hidden");
    return;
  }

  mentionPopup.innerHTML = "";
  state.mention.filtered.forEach((file, index) => {
    const item = document.createElement("div");
    item.className = "mention-item" + (index === state.mention.selectedIndex ? " selected" : "");
    const isDir = file.endsWith("/");
    item.innerHTML = `<span class="mention-icon">${isDir ? "📁" : "📄"}</span><span>${escapeHtml(file)}</span>`;
    item.onclick = () => insertMention(file);
    mentionPopup.appendChild(item);
  });

  mentionPopup.classList.remove("hidden");
  // Scroll selected into view
  const selected = mentionPopup.querySelector(".selected");
  if (selected) selected.scrollIntoView({ block: "nearest" });
}

function handleMentionInput(e) {
  const val = e.target.value;
  const pos = e.target.selectionStart;
  const before = val.slice(0, pos);

  // Look for last '@' that isn't escaped or inside code (simplified)
  const lastAt = before.lastIndexOf("@");

  if (lastAt !== -1 && (lastAt === 0 || /\s/.test(before[lastAt - 1]))) {
    const query = before.slice(lastAt + 1).toLowerCase();

    loadFiles().catch(() => {});

    // Deactivate if there's a space after the @ (e.g. user finished typing or just typing email-like thing)
    if (query.includes(" ")) {
      state.mention.active = false;
    } else {
      state.mention.active = true;
      state.mention.query = query;
      state.mention.startIndex = lastAt;
      state.mention.filtered = state.workspaceFiles
        .filter(f => f.toLowerCase().includes(query))
        .slice(0, 100);
      state.mention.selectedIndex = 0;
    }
  } else {
    state.mention.active = false;
  }
  updateMentionPopup();
}

function handleMentionKeydown(e) {
  if (!state.mention.active || state.mention.filtered.length === 0) return false;

  if (e.key === "ArrowDown") {
    e.preventDefault();
    state.mention.selectedIndex = (state.mention.selectedIndex + 1) % state.mention.filtered.length;
    updateMentionPopup();
    return true;
  }
  if (e.key === "ArrowUp") {
    e.preventDefault();
    state.mention.selectedIndex = (state.mention.selectedIndex - 1 + state.mention.filtered.length) % state.mention.filtered.length;
    updateMentionPopup();
    return true;
  }
  if (e.key === "Enter" || e.key === "Tab") {
    e.preventDefault();
    const selected = state.mention.filtered[state.mention.selectedIndex];
    if (selected) insertMention(selected);
    return true;
  }
  if (e.key === "Escape") {
    state.mention.active = false;
    updateMentionPopup();
    return true;
  }
  return false;
}

function insertMention(file) {
  const val = elements.input.value;
  const before = val.slice(0, state.mention.startIndex);
  const after = val.slice(elements.input.selectionStart);
  elements.input.value = before + "@" + file + " " + after;
  state.mention.active = false;
  updateMentionPopup();
  elements.input.focus();
  autoResize();
}

function stopStreaming() {
  if (abortController) abortController.abort();
}

/* ── Event listeners ─────────────────────────── */
elements.newChatBtn.addEventListener("click", () => createChat("", true));
elements.backBtn.addEventListener("click", goHome);

// Scroll detection: if user scrolls up during streaming, stop auto-scroll
elements.conversation.addEventListener("scroll", () => {
  if (!state.isStreaming) return;
  const el = elements.conversation;
  const gap = el.scrollHeight - el.scrollTop - el.clientHeight;
  // If user scrolled up more than 150px from bottom, respect their position
  if (gap > 150) {
    userScrolledUp = true;
  } else {
    userScrolledUp = false;
  }
});

// Expand — open in editor tab
elements.expandBtn.addEventListener("click", () => {
  vscode.postMessage({ type: "expand" });
});

// Send or Stop
elements.sendBtn.addEventListener("click", () => {
  if (state.isStreaming) stopStreaming();
  else sendRequest();
});

elements.input.addEventListener("input", (e) => {
  autoResize();
  handleMentionInput(e);
});
elements.input.addEventListener("keydown", (e) => {
  if (handleMentionKeydown(e)) return;

  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    if (!state.isStreaming) sendRequest();
  }
});

// Model / Mode
elements.modelPickerBtn.addEventListener("click", (e) => {
  e.stopPropagation();
  togglePicker("model");
});
elements.modePickerBtn.addEventListener("click", (e) => {
  e.stopPropagation();
  togglePicker("mode");
});
elements.modelPickerMenu.addEventListener("click", (e) => {
  const option = e.target.closest("[data-pick-model]");
  if (!option) return;
  state.settings.model = option.dataset.pickModel;
  persistState();
  syncControls();
  closePickers();
});
elements.modePickerMenu.addEventListener("click", (e) => {
  const option = e.target.closest("[data-pick-mode]");
  if (!option) return;
  state.settings.mode = option.dataset.pickMode;
  persistState();
  syncControls();
  closePickers();
});
elements.bottomModelSelect.addEventListener("change", (e) => {
  state.settings.model = e.target.value;
  persistState();
});
elements.bottomModeSelect.addEventListener("change", (e) => {
  state.settings.mode = e.target.value;
  persistState();
  syncControls();
});
document.addEventListener("click", (e) => {
  if (e.target.closest(".picker-shell")) return;
  closePickers();
});
elements.refreshModelsBtn.addEventListener("click", async () => {
  if (isRefreshingModels) return;
  isRefreshingModels = true;
  elements.refreshModelsBtn.textContent = "...";
  syncControls();
  await loadModels();
  isRefreshingModels = false;
  elements.refreshModelsBtn.textContent = "↻";
  syncControls();
});

// Delete confirmation
elements.confirmCancel.addEventListener("click", cancelDelete);
elements.confirmOk.addEventListener("click", confirmDelete);
elements.confirmOverlay.addEventListener("click", (e) => {
  if (e.target === elements.confirmOverlay) cancelDelete();
});

// Copy & Delete delegation
document.addEventListener("click", async (e) => {
  const copyBtn = e.target.closest("[data-copy]");
  if (copyBtn) {
    await navigator.clipboard.writeText(
      decodeURIComponent(copyBtn.dataset.copy)
    );
    copyBtn.textContent = "Copied";
    setTimeout(() => {
      copyBtn.textContent = "Copy";
    }, 1000);
    return;
  }

  const createFileBtn = e.target.closest("[data-create-file]");
  if (createFileBtn) {
    const rawCode = decodeURIComponent(createFileBtn.dataset.createFile);
    const extracted = extractFilenameFromCode(rawCode);
    vscode.postMessage({
      type: "createFile",
      payload: {
        code: extracted ? extracted.cleanCode : rawCode,
        defaultName: extracted ? extracted.fileName : ""
      }
    });
    return;
  }

  const applyBtn = e.target.closest("[data-apply]");
  if (applyBtn) {
    const code = decodeURIComponent(applyBtn.dataset.apply);
    vscode.postMessage({
      type: "applyCode",
      payload: { code }
    });
    const originalText = applyBtn.textContent;
    applyBtn.textContent = "Applied!";
    setTimeout(() => {
      applyBtn.textContent = originalText;
    }, 2000);
    return;
  }

  const delBtn = e.target.closest("[data-delete-chat]");
  if (delBtn) {
    requestDelete(delBtn.dataset.deleteChat);
    return;
  }

  const actionBtn = e.target.closest(".action-btn");
  if (actionBtn) {
    const action = actionBtn.dataset.action;
    if (action) {
      elements.input.value = action;
      sendRequest();
    }
  }

  const acceptDiffBtn = e.target.closest("[data-accept-diff]");
  if (acceptDiffBtn) {
    const path = decodeURIComponent(acceptDiffBtn.dataset.acceptDiff);
    acceptDiffBtn.disabled = true;
    acceptDiffBtn.textContent = "Accepted...";
    elements.input.value = `[ACTION:accept_diff] ${path}`;
    sendRequest();
    return;
  }

  const rejectDiffBtn = e.target.closest("[data-reject-diff]");
  if (rejectDiffBtn) {
    const path = decodeURIComponent(rejectDiffBtn.dataset.rejectDiff);
    rejectDiffBtn.disabled = true;
    rejectDiffBtn.textContent = "Rejected...";
    elements.input.value = `[ACTION:reject_diff] ${path}`;
    sendRequest();
    return;
  }
});

window.addEventListener("message", (e) => {
  const { type, requestId, payload, path } = e.data || {};

  if (type === "hydrate") hydrate(payload);
  if (type === "savedChats") loadSavedChats(payload);
  if (type === "extensionResponse" && requestId) {
    const pending = pendingExtensionRequests.get(requestId);
    if (pending) {
      pendingExtensionRequests.delete(requestId);
      pending.resolve(payload || {});
    }
  }
  if (type === "extensionError" && requestId) {
    const pending = pendingExtensionRequests.get(requestId);
    if (pending) {
      pendingExtensionRequests.delete(requestId);
      pending.reject(new Error(payload?.message || "Extension request failed"));
    }
  }
  if (type === "askChunk" && requestId) {
    const pending = pendingExtensionRequests.get(requestId);
    if (pending?.onChunk) pending.onChunk(payload?.text || "");
  }
  if (type === "askDone" && requestId) {
    const pending = pendingExtensionRequests.get(requestId);
    if (pending) {
      pendingExtensionRequests.delete(requestId);
      pending.resolve(payload || {});
    }
  }
  if (type === "askError" && requestId) {
    const pending = pendingExtensionRequests.get(requestId);
    if (pending) {
      pendingExtensionRequests.delete(requestId);
      pending.reject(new Error(payload?.message || "Ollama request failed"));
    }
  }
  if (type === "createChat") createChat("", true);
  if (type === "setWorkspace") {
    window.__WORKSPACE_PATH__ = path;
    requestExtension("setWorkspace", { workspace: path }).then(() => loadFiles()).catch(() => { });
  }
  if (type === "filesChanged") {
    // Live update workspace files list for @ mentions
    if (Array.isArray(payload?.files)) {
      state.workspaceFiles = payload.files;
      if (state.mention.active) {
        state.mention.filtered = state.workspaceFiles
          .filter(f => f.toLowerCase().includes((state.mention.query || "").toLowerCase()))
          .slice(0, 100);
        state.mention.selectedIndex = 0;
        updateMentionPopup();
      }
    }
  }
  if (type === "filesCreated") {
    // Refresh file list after auto-creation
    loadFiles();
  }
});


// Voice recording placeholder. Packaged Arceus does not require the old Python backend.
const voiceState = {
  isRecording: false,
};

if (elements.micBtn) {
  const startRecording = async () => {
    if (voiceState.isRecording) return;
    try {
      console.log("🎤 Voice: Requesting backend start...");
      const data = await requestExtension("startVoice", {}, 5000);

      if (data.status === "started") {
        voiceState.isRecording = true;
        elements.micBtn.classList.add("recording");
        elements.input.placeholder = "Listening...";
        elements.input.classList.add("listening");
      } else {
        throw new Error(data.message || "Failed to start backend mic");
      }
    } catch (err) {
      console.error("🎤 Voice Start Failed:", err);
      elements.input.placeholder = "Voice input is not available yet.";
      setTimeout(() => {
        elements.input.placeholder = "Ask Arceus anything…";
      }, 3000);
    }
  };

  const stopRecordingAction = async () => {
    if (!voiceState.isRecording) return;
    voiceState.isRecording = false;

    // UI immediate reset
    elements.micBtn.classList.remove("recording");
    elements.input.classList.remove("listening");
    elements.input.placeholder = "Transcribing...";

    try {
      console.log("🎤 Voice: Requesting backend stop...");
      const data = await requestExtension("stopVoice", {}, 10000);

      if (data.text && data.text.trim()) {
        elements.input.value = data.text;
        sendRequest();
      }
    } catch (err) {
      console.error("🎤 Voice Stop Failed:", err);
    } finally {
      elements.input.placeholder = "Ask Arceus anything…";
    }
  };

  elements.micBtn.addEventListener("mousedown", (e) => {
    e.preventDefault();
    startRecording();
  });

  elements.micBtn.addEventListener("mouseup", (e) => {
    e.preventDefault();
    stopRecordingAction();
  });

  elements.micBtn.addEventListener("mouseleave", () => {
    if (voiceState.isRecording) stopRecordingAction();
  });

  elements.micBtn.addEventListener("touchstart", (e) => {
    e.preventDefault();
    startRecording();
  }, { passive: false });

  elements.micBtn.addEventListener("touchend", (e) => {
    e.preventDefault();
    stopRecordingAction();
  }, { passive: false });

}

// Safety: stop if released anywhere else
window.addEventListener("mouseup", () => {
  if (voiceState.isRecording) {
    stopRecordingAction();
  }
});

/* ── Journal Logic ────────────────────────────── */
async function fetchJournalTasks() {
  try {
    const data = await requestExtension("listJournal", {}, 5000);
    renderJournalList(data.tasks || []);
  } catch (err) {
    elements.journalList.innerHTML = `<div class="empty-state">No task journal is available yet.</div>`;
  }
}

function renderJournalList(tasks) {
  if (!tasks.length) {
    elements.journalList.innerHTML = `<div class="empty-state">No tasks recorded yet.</div>`;
    return;
  }

  elements.journalList.innerHTML = tasks.map(task => {
    const time = new Date(task.timestamp * 1000).toLocaleString();
    const durationStr = task.duration ? ` • ${task.duration}s` : '';
    return `
      <div class="journal-item" data-task-id="${task.id}">
        <div class="journal-row">
          <div class="journal-title">${escapeHtml(task.request || "No request")}</div>
        </div>
        <div class="journal-meta">
          <span class="journal-status ${task.status}">${task.status}</span>
          <span>${time}${durationStr}</span>
          ${task.files_changed?.length ? `<span>• ${task.files_changed.length} file(s) changed</span>` : ''}
        </div>
      </div>
    `;
  }).join("");
}

async function fetchAndShowTaskDetail(id) {
  elements.journalDetailContent.innerHTML = `<div class="typing-dots" style="margin:20px;"><span></span><span></span><span></span></div>`;
  elements.journalDetailView.classList.add("open");

  try {
    const task = await requestExtension("getJournalTask", { id }, 5000);

    let html = `
      <div class="journal-section-title">Request</div>
      <div class="journal-data-box" style="white-space: pre-wrap;">${escapeHtml(task.request)}</div>
      
      <div class="journal-section-title">Status</div>
      <div class="journal-meta" style="margin-bottom: 12px;">
        <span class="journal-status ${task.status}">${task.status}</span>
        ${task.verification_status ? `<span class="journal-status ${task.verification_status}">Verif: ${task.verification_status}</span>` : ''}
        <span>Duration: ${task.duration}s</span>
      </div>
    `;

    if (task.files_changed?.length) {
      html += `
        <div class="journal-section-title">Files Changed</div>
        <div class="journal-data-box">
          ${task.files_changed.map(f => `<div>• ${escapeHtml(f)}</div>`).join("")}
        </div>
      `;
    }

    if (task.failures?.length) {
      html += `<div class="journal-section-title" style="color: #f87171;">Failures / Fixes</div>`;
      task.failures.forEach(f => {
        html += `
          <div class="journal-data-box journal-error" style="margin-bottom: 8px;">
            <strong>${f.phase}:</strong><br>
            ${escapeHtml(f.error)}
          </div>
        `;
      });
    }

    if (task.steps?.length) {
      html += `<div class="journal-section-title">Execution Steps (${task.steps.length})</div>`;
      task.steps.forEach((step, i) => {
        html += `
          <div class="journal-data-box" style="margin-bottom: 8px;">
            <strong style="color:var(--accent)">Step ${i + 1}:</strong> ${escapeHtml(step.action)}
            <div style="opacity:0.7; margin-top:4px;">${escapeHtml(step.target)}</div>
          </div>
        `;
      });
    }

    elements.journalDetailContent.innerHTML = html;
  } catch (err) {
    elements.journalDetailContent.innerHTML = `<div class="empty-state">Failed to load details.</div>`;
  }
}

// Event Listeners for Journal
elements.journalBtn.addEventListener("click", () => {
  if (state.view === "journal") {
    goHome();
  } else {
    openJournal();
  }
});

elements.journalList.addEventListener("click", (e) => {
  const item = e.target.closest(".journal-item");
  if (!item) return;
  fetchAndShowTaskDetail(item.dataset.taskId);
});

elements.closeJournalDetailBtn.addEventListener("click", () => {
  elements.journalDetailView.classList.remove("open");
});

autoResize();
async function init() {
  // 1. Sync workspace with backend first
  if (window.__WORKSPACE_PATH__) {
    console.log("📂 Syncing workspace:", window.__WORKSPACE_PATH__);
    try {
      await requestExtension("setWorkspace", { workspace: window.__WORKSPACE_PATH__ }, 5000);
    } catch (err) {
      console.error("Failed to sync workspace", err);
    }
  }

  // 2. Load data
  await Promise.all([
    loadModels(),
    loadFiles()
  ]);

  // 3. Notify extension
  vscode.postMessage({ type: "ready" });

  // 4. Secondary sync
  // 4. Secondary sync with retries for backend startup
  let attempts = 0;
  const trySecondarySync = async () => {
    await loadModels();
    syncControls();
    if (state.availableModels.length === 0 && attempts < 10) {
      attempts++;
      setTimeout(trySecondarySync, 1000);
    }
  };
  setTimeout(trySecondarySync, 500);
}

init();
