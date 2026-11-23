const LOCAL_KEY = 'workspaceV1';
const CONFIG_KEY = 'profilesV1';
const SECRET_KEY = 'secretsV1';
export function emptyWorkspace() {
  return { version: 1, sessionId: crypto.randomUUID(), sessions: [], source: { text: '', title: '', url: '', mode: 'paste' }, bank: { name: '网页题库', questions: [], reviewItems: [] }, excluded: [], resolvedReviews: [], messages: [], generation: null, activeView: 'chat', jsonDraft: '', documents: [], activeDocumentId: '', exportTask: null, pendingExport: null, progressHidden: false };
}

function savedSession(state) {
  return { sessionId: state.sessionId, messages: state.messages, generation: state.generation, exportTask: state.exportTask, pendingExport: state.pendingExport, progressHidden: state.progressHidden, activeDocumentId: state.activeDocumentId, source: state.source, jsonDraft: state.jsonDraft };
}
function archiveSession(state) {
  const sessions = state.sessions.filter(item => item.sessionId !== state.sessionId);
  if (state.messages.length || state.documents.some(doc => doc.sessionId === state.sessionId)) sessions.push(savedSession(state));
  return sessions;
}
export function newConversation(state) {
  return emptyWorkspace();
}

export function hasQuizDrafts(state) {
  return Boolean(state.documents.length || state.bank.questions.length || state.bank.reviewItems.length || state.exportTask?.snapshots?.length);
}
export function documentConversation(state, doc) {
  if (doc.sessionId === state.sessionId) return state;
  const saved = state.sessions.find(item => item.sessionId === doc.sessionId);
  if (!saved) throw new Error('这份文档的会话记录缺失，请重新打开侧边栏。');
  return { ...emptyWorkspace(), ...saved, documents: state.documents, sessions: archiveSession(state).filter(item => item.sessionId !== doc.sessionId), bank: doc.bank, excluded: doc.excluded, resolvedReviews: doc.resolvedReviews, activeDocumentId: doc.id, source: doc.source };
}

export async function protectStorage() {
  await chrome.storage.local.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' });
  await chrome.storage.session.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' });
}

export async function loadWorkspace() {
  const saved = (await chrome.storage.local.get(LOCAL_KEY))[LOCAL_KEY];
  if (!saved || saved.version !== 1) return emptyWorkspace();
  const state = { ...emptyWorkspace(), ...saved, source: { ...emptyWorkspace().source, ...saved.source } };
  if (state.activeView === 'bank') state.activeView = 'chat';
  for (const doc of state.documents) doc.sessionId ||= state.sessionId;
  if (!state.documents.length && (state.bank.questions.length || state.bank.reviewItems.length)) {
    const id = crypto.randomUUID();
    state.documents.push({ id, sessionId: state.sessionId, name: state.bank.name, bank: state.bank, excluded: state.excluded, resolvedReviews: state.resolvedReviews, source: state.source,
      createdAt: new Date().toISOString(), formatComplete: !state.generation || state.generation.next >= state.generation.chunks.length,
      coverage: { complete: false, expected: null, captured: state.bank.questions.length + state.bank.reviewItems.length, reason: '从旧版本保留的草稿，未验证整库覆盖。' }, partialAccepted: false });
    state.activeDocumentId = id;
  }
  return state;
}
export async function saveWorkspace(workspace) { await chrome.storage.local.set({ [LOCAL_KEY]: workspace }); }

export async function loadProfiles() {
  const value = (await chrome.storage.local.get(CONFIG_KEY))[CONFIG_KEY];
  return value && Array.isArray(value.items) ? value : { items: [], activeId: '' };
}

export async function getSecret(id) {
  const session = (await chrome.storage.session.get(SECRET_KEY))[SECRET_KEY] || {};
  const local = (await chrome.storage.local.get(SECRET_KEY))[SECRET_KEY] || {};
  return session[id] || local[id] || '';
}

export async function setSecret(id, key, remember) {
  const session = (await chrome.storage.session.get(SECRET_KEY))[SECRET_KEY] || {};
  const local = (await chrome.storage.local.get(SECRET_KEY))[SECRET_KEY] || {};
  delete session[id]; delete local[id];
  if (key) (remember ? local : session)[id] = key;
  await chrome.storage.session.set({ [SECRET_KEY]: session });
  await chrome.storage.local.set({ [SECRET_KEY]: local });
}

export async function saveProfiles(profiles) { await chrome.storage.local.set({ [CONFIG_KEY]: profiles }); }
