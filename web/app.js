const $ = (sel) => document.querySelector(sel);
const post = (msg) => window.chrome?.webview?.postMessage(msg);
const esc = (s) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

const store = {
  get(key, fallback) {
    try { return JSON.parse(localStorage.getItem(key)) ?? fallback; } catch { return fallback; }
  },
  set(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* storage unavailable */ }
  },
};

const CALLOUT_COLORS = {
  note: '#448aff', info: '#448aff', todo: '#448aff',
  abstract: '#00b0ff', summary: '#00b0ff', tldr: '#00b0ff',
  tip: '#00bfa5', hint: '#00bfa5', important: '#00bfa5',
  success: '#08b94e', check: '#08b94e', done: '#08b94e',
  question: '#ec7500', help: '#ec7500', faq: '#ec7500',
  warning: '#ec7500', caution: '#ec7500', attention: '#ec7500',
  failure: '#e93147', fail: '#e93147', missing: '#e93147',
  danger: '#e93147', error: '#e93147', bug: '#e93147',
  example: '#7852ee', quote: '#9e9e9e', cite: '#9e9e9e',
};

/* ---------- State ---------- */

// Each tab shows one note (or nothing yet) from one root folder; tabs can come from different folders.
// A tab: { root, path, title, scroll, back: [{ path, scroll }], forward: [...] }
let tabs = [];
let activeTab = null;
let current = null;      // path of the note shown in the active tab
let currentRoot = null;  // root folder id shown in the sidebar (the active tab's)
const trees = new Map();     // root id -> folder tree
const rootNames = new Map(); // root id -> folder name

// View mode: 'read' | 'edit' | 'split'. The editor module is only imported on the first
// switch away from 'read', then kept for the rest of the session.
let viewMode = 'read';
let editor = null;

const apiQuery = (root, path) =>
  `?r=${encodeURIComponent(root)}` + (path != null ? `&n=${encodeURIComponent(path)}` : '');
const noteTitle = (path) => path.slice(path.lastIndexOf('/') + 1).replace(/\.(md|markdown)$/i, '');
const homeNote = (tree) => tree?.children.find((n) => !n.children && /^(readme|index|home)$/i.test(n.name));

/* ---------- Sidebar ---------- */

const expandedSets = new Map(); // root id -> Set of expanded folder paths
function expandedFor(root) {
  if (!expandedSets.has(root)) expandedSets.set(root, new Set(store.get(`expanded:${root}`, [])));
  return expandedSets.get(root);
}
const saveExpanded = (root) => store.set(`expanded:${root}`, [...expandedFor(root)]);

const treeRequests = new Map(); // root id -> latest loadTree promise

function loadTree(root) {
  const request = fetchTree(root);
  treeRequests.set(root, request);
  return request;
}

async function fetchTree(root) {
  const res = await fetch('/__api/tree' + apiQuery(root));
  if (!res.ok) return null;
  const tree = await res.json();
  trees.set(root, tree);
  rootNames.set(root, tree.name);
  for (const t of tabs) if (t.root === root && !t.path) t.title = tree.name;
  renderTabs();
  if (root === currentRoot) {
    if (current) expandAncestors(current);
    renderTree();
  }
  return tree;
}

function allNotes(node, out = []) {
  for (const child of node.children ?? []) {
    if (child.children) allNotes(child, out); else out.push(child);
  }
  return out;
}

function renderTree() {
  const nav = $('#tree');
  const root = currentRoot;
  const tree = trees.get(root);
  $('#root-name').textContent = rootNames.get(root) ?? '';
  nav.replaceChildren();
  if (!tree) return;

  const query = $('#filter').value.trim().toLowerCase();
  if (query) {
    const matches = allNotes(tree)
      .filter((n) => n.path.toLowerCase().includes(query))
      .sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name));
    function rank(n) {
      const name = n.name.toLowerCase();
      return name.startsWith(query) ? 0 : name.includes(query) ? 1 : 2;
    }
    for (const n of matches) {
      const el = fileItem(n);
      const dir = n.path.includes('/') ? n.path.slice(0, n.path.lastIndexOf('/')) : '';
      if (dir) el.insertAdjacentHTML('beforeend', `<span class="match-dir">${esc(dir)}</span>`);
      nav.append(el);
    }
    if (!matches.length) nav.innerHTML = '<div class="tree-empty">No matching notes</div>';
  } else {
    nav.append(...tree.children.map((n) => buildNode(n, root)));
    if (!tree.children.length) nav.innerHTML = '<div class="tree-empty">No Markdown files in this folder</div>';
  }
  markActive();
}

function fileItem(n) {
  const el = document.createElement('div');
  el.className = 'tree-item file' + (n.path === current ? ' active' : '');
  el.dataset.path = n.path;
  el.title = n.path;
  el.innerHTML = `<span>${esc(n.name)}</span>`;
  el.onclick = (e) => openIn(currentRoot, n.path, clickTarget(e));
  el.addEventListener('mousedown', (e) => { if (e.button === 1) e.preventDefault(); }); // no autoscroll
  el.addEventListener('auxclick', (e) => { if (e.button === 1) openIn(currentRoot, n.path, clickTarget(e, true)); });
  el.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    const root = currentRoot;
    showContextMenu(e.clientX, e.clientY, [
      { label: 'Open', action: () => openIn(root, n.path, 'current') },
      { label: 'Open in new tab', hint: 'Ctrl+click', action: () => openIn(root, n.path, 'background') },
      { label: 'Open in new window', hint: 'Shift+click', action: () => openIn(root, n.path, 'window') },
    ]);
  });
  return el;
}

/**
 * Where a click should open a note, following browser conventions:
 * Ctrl+click or middle-click opens a background tab (with Shift: a tab you switch to), Shift+click a new window.
 */
function clickTarget(e, middle = false) {
  if (e.ctrlKey || e.metaKey || middle) return e.shiftKey ? 'tab' : 'background';
  if (e.shiftKey) return 'window';
  return 'current';
}

/** Opens a note in 'current' tab, a new 'tab', a 'background' tab or a new 'window'. */
function openIn(root, path, target, hash = '') {
  if (target === 'window') post({ type: 'openWindow', root, path });
  else if (target === 'tab' || target === 'background') openInNewTab(root, path, { background: target === 'background' });
  // Never replace an unsaved new note: open next to it instead.
  else if (!activeTab || activeTab.root !== root || activeTab.draft) openInNewTab(root, path);
  else openNote(path, { hash });
}

/* ---------- Context menu ---------- */

let contextMenu = null;

function closeContextMenu() {
  contextMenu?.remove();
  contextMenu = null;
}

/** Shows a small menu at (x, y). items: [{ label, hint?, action }] */
function showContextMenu(x, y, items) {
  closeContextMenu();
  const menu = document.createElement('div');
  menu.className = 'context-menu';
  menu.setAttribute('role', 'menu');
  for (const item of items) {
    const btn = document.createElement('button');
    btn.setAttribute('role', 'menuitem');
    btn.innerHTML = `<span>${esc(item.label)}</span>${item.hint ? `<kbd>${esc(item.hint)}</kbd>` : ''}`;
    btn.onclick = () => {
      closeContextMenu();
      item.action();
    };
    menu.append(btn);
  }
  menu.addEventListener('keydown', (e) => {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    e.preventDefault();
    const buttons = [...menu.querySelectorAll('button')];
    const i = buttons.indexOf(document.activeElement);
    buttons[(i + (e.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length].focus();
  });
  document.body.append(menu);

  // Keep the menu inside the window.
  const { width, height } = menu.getBoundingClientRect();
  menu.style.left = `${Math.max(4, Math.min(x, innerWidth - width - 4))}px`;
  menu.style.top = `${Math.max(4, Math.min(y, innerHeight - height - 4))}px`;
  contextMenu = menu;
  menu.querySelector('button').focus({ preventScroll: true });
}

addEventListener('pointerdown', (e) => {
  if (contextMenu && !contextMenu.contains(e.target)) closeContextMenu();
});
addEventListener('keydown', (e) => {
  if (e.key === 'Escape') closeContextMenu();
});
addEventListener('blur', closeContextMenu);
addEventListener('wheel', closeContextMenu, { passive: true });

function buildNode(n, root) {
  if (!n.children) return fileItem(n);

  const expanded = expandedFor(root);
  const el = document.createElement('div');
  el.className = 'tree-item folder' + (expanded.has(n.path) ? '' : ' collapsed');
  el.innerHTML = `<svg class="chev" viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2"><path d="m6 9 6 6 6-6"/></svg><span>${esc(n.name)}</span>`;
  const children = document.createElement('div');
  children.className = 'tree-children';
  // Build a folder's contents only once it is opened, so huge folders render quickly.
  const fill = () => {
    if (!children.hasChildNodes()) children.append(...n.children.map((c) => buildNode(c, root)));
  };
  if (expanded.has(n.path)) fill();

  el.onclick = () => {
    const open = el.classList.toggle('collapsed') === false;
    if (open) {
      expanded.add(n.path);
      fill();
    } else {
      expanded.delete(n.path);
    }
    saveExpanded(root);
  };

  const frag = document.createDocumentFragment();
  frag.append(el, children);
  return frag;
}

function markActive() {
  for (const el of document.querySelectorAll('.tree-item.file')) {
    el.classList.toggle('active', el.dataset.path === current);
  }
  document.querySelector('.tree-item.active')?.scrollIntoView({ block: 'nearest' });
}

/** Expands the folders containing a note; returns true if any were collapsed. */
function expandAncestors(path) {
  const expanded = expandedFor(currentRoot);
  const parts = path.split('/');
  let changed = false;
  for (let i = 1; i < parts.length; i++) {
    const dir = parts.slice(0, i).join('/');
    if (!expanded.has(dir)) { expanded.add(dir); changed = true; }
  }
  if (changed) saveExpanded(currentRoot);
  return changed;
}

/* ---------- Tabs ---------- */

const tabEls = new Map(); // tab -> element

function createTab(root, path) {
  return { root, path, title: path ? noteTitle(path) : rootNames.get(root) ?? '', scroll: 0, back: [], forward: [] };
}

/** Updates the tab bar in place (elements are reused, so a tab being dragged keeps its pointer capture). */
function renderTabs() {
  const bar = $('#tabs');
  for (const [tab, el] of tabEls) {
    if (!tabs.includes(tab)) { el.remove(); tabEls.delete(tab); }
  }
  tabs.forEach((tab, i) => {
    let el = tabEls.get(tab);
    if (!el) { el = tabElement(tab); tabEls.set(tab, el); }
    el.classList.toggle('active', tab === activeTab);
    el.setAttribute('aria-selected', String(tab === activeTab));
    el.querySelector('.tab-title').textContent = tab.title || 'New tab';
    el.title = [rootNames.get(tab.root), tab.path].filter(Boolean).join(' / ');
    if (bar.children[i] !== el) bar.insertBefore(el, bar.children[i] ?? null);
  });
  tabEls.get(activeTab)?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
}

function tabElement(tab) {
  const el = document.createElement('div');
  el.className = 'tab';
  el.setAttribute('role', 'tab');
  el.innerHTML = `<span class="tab-title"></span>
    <button class="tab-close" title="Close (Ctrl+W)" aria-label="Close tab">
      <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="M6 6l12 12M18 6 6 18"/></svg>
    </button>`;
  el._tab = tab;
  el.querySelector('.tab-close').onclick = (e) => { e.stopPropagation(); closeTab(tab); };
  el.addEventListener('mousedown', (e) => { if (e.button === 1) e.preventDefault(); }); // no autoscroll
  el.addEventListener('auxclick', (e) => { if (e.button === 1) closeTab(tab); });
  el.addEventListener('pointerdown', (e) => startTabDrag(e, tab, el));
  return el;
}

async function activateTab(tab) {
  if (tab === activeTab) return;
  // Leaving a new note keeps its text in the tab; leaving a saved note saves it.
  if (activeTab?.draft) activeTab.draftText = editor?.text() ?? activeTab.draftText;
  else if (editor && !(await editor.save())) return;
  if (activeTab) activeTab.scroll = $('#view').scrollTop;
  activeTab = tab;
  openedInBackground = 0;
  const rootChanged = tab.root !== currentRoot;
  currentRoot = tab.root;
  renderTabs();
  if (rootChanged) {
    renderTree();
    if (!trees.has(tab.root)) loadTree(tab.root);
  }
  if (tab.draft) await showDraft(tab);
  else if (tab.path) await openNote(tab.path, { history: 'none', scrollTo: tab.scroll });
  else showEmpty();
  reportDirty();
}

/* ---------- New notes ---------- */

// A new note lives only in its tab ({ draft: true, draftText }) until its first save,
// which asks where to save it (Ctrl+S, or "Save" when closing it).

/** Ctrl+N: a new, unsaved note in a new tab, opened for editing. */
async function newNote() {
  if (!currentRoot) return;
  const tab = createTab(currentRoot, null);
  tab.draft = true;
  tab.draftText = '';
  tab.title = 'Untitled';
  tabs.splice(activeTab ? tabs.indexOf(activeTab) + 1 : tabs.length, 0, tab);
  await activateTab(tab);
}

const draftRef = (tab) => ({ root: tab.root, draft: true, text: tab.draftText ?? '' });
const draftText = (tab) => (tab === activeTab && editor ? editor.text() : tab.draftText) ?? '';

/** Shows a new note: in the editor (switching to Edit mode if needed), or as a preview in Read mode. */
async function showDraft(tab) {
  current = null;
  document.body.classList.remove('plain-file'); // new notes are always Markdown
  markActive();
  document.title = `${tab.title} - MRAkdown`;
  if (viewMode === 'read' && !tab.draftText) {
    await setViewMode('edit');
  } else if (viewMode === 'read') {
    await renderDraft(tab);
  } else {
    await editor.load(draftRef(tab));
    editor.renderPreview();
    editor.focus();
  }
}

async function renderDraft(tab) {
  const res = await fetch('/__api/render' + apiQuery(tab.root, ''), { method: 'POST', body: tab.draftText ?? '' });
  if (res.ok && activeTab === tab) showNote({ ...(await res.json()), title: tab.title });
}

/** A file name suggestion from the first heading or line of a new note. */
function suggestName(text) {
  const first = text.split('\n').map((l) => l.replace(/^#+\s*/, '').trim()).find(Boolean) ?? '';
  return first.replace(/[\\/:*?"<>|#^[\]]/g, '').slice(0, 60).trim() || 'Untitled';
}

/** First save of the active new note: the host asks where to save it. Resolves to { root, path } or null. */
async function saveDraftAs(text) {
  const tab = activeTab;
  const saved = await callHost('saveAs', { root: tab.root, text, name: suggestName(text) });
  if (!saved) return null;

  rootNames.set(saved.root, saved.rootName);
  tab.draft = false;
  delete tab.draftText;
  tab.root = saved.root;
  tab.path = saved.path;
  tab.title = noteTitle(saved.path);
  if (activeTab === tab) {
    current = saved.path;
    document.title = `${tab.title} - MRAkdown`;
    if (currentRoot !== saved.root) {
      currentRoot = saved.root;
      renderTree();
    }
    loadTree(saved.root);
  }
  renderTabs();
  return { root: saved.root, path: saved.path };
}

/**
 * Closing a new note that has text: asks Save / Don't save / Cancel.
 * Resolves true when it's fine to close it (saved or discarded).
 */
async function confirmCloseDraft(tab) {
  if (!draftText(tab).trim()) return true;
  if (tab !== activeTab) await activateTab(tab);
  const answer = await callHost('askSave', { title: tab.title });
  if (answer === 'cancel') return false;
  if (answer === 'no') return true;
  return editor.save({ explicit: true });
}

/* ---------- Requests to the host ---------- */

const hostCalls = new Map(); // request id -> resolve
let nextCallId = 1;

/** Sends a request to the host and resolves with its reply (see Reply in MainForm). */
function callHost(type, data = {}) {
  const id = nextCallId++;
  return new Promise((resolve) => {
    hostCalls.set(id, resolve);
    post({ type, id, ...data });
  });
}

/** Tells the host whether closing the window would lose anything (unsaved edits or new notes with text). */
let reportedDirty = false;
function reportDirty() {
  const dirty = document.body.classList.contains('dirty')
    || tabs.some((t) => t.draft && t !== activeTab && t.draftText?.trim());
  if (dirty === reportedDirty) return;
  reportedDirty = dirty;
  post({ type: 'dirty', value: dirty });
}

// Background tabs opened from the active tab line up after it in order, like in a browser.
let openedInBackground = 0;

async function openInNewTab(root, path, { background = false } = {}) {
  const tab = createTab(root, path);
  if (!activeTab) {
    tabs.push(tab);
    await activateTab(tab);
  } else if (background) {
    tabs.splice(tabs.indexOf(activeTab) + 1 + openedInBackground++, 0, tab);
    renderTabs();
  } else {
    tabs.splice(tabs.indexOf(activeTab) + 1, 0, tab);
    await activateTab(tab);
  }
  return tab;
}

const closedTabs = []; // for Ctrl+Shift+T: { root, path, index }

async function reopenClosedTab() {
  const closed = closedTabs.pop();
  if (!closed) return;
  const tab = createTab(closed.root, closed.path);
  tabs.splice(Math.min(closed.index, tabs.length), 0, tab);
  await activateTab(tab);
}

/** Ctrl+T: an empty tab for the current folder, with the note search focused. */
async function newEmptyTab() {
  if (!currentRoot) return;
  const tab = createTab(currentRoot, null);
  tabs.splice(activeTab ? tabs.indexOf(activeTab) + 1 : tabs.length, 0, tab);
  await activateTab(tab);
  if (document.body.classList.contains('side-hidden')) toggleSidebar();
  filter.focus();
}

/** Ctrl+1…8 jump to that tab, Ctrl+9 to the last one. */
function jumpToTab(n) {
  const tab = n === 9 ? tabs.at(-1) : tabs[n - 1];
  if (tab) activateTab(tab);
}

/** remember: false when the tab moved to another window rather than being closed. */
async function closeTab(tab, { remember = true } = {}) {
  if (tab.draft) {
    if (!(await confirmCloseDraft(tab))) return;
  } else if (tab === activeTab && editor && !(await editor.save())) {
    return;
  }
  const i = tabs.indexOf(tab);
  if (i < 0) return;
  tabs.splice(i, 1);
  if (remember && tab.path) closedTabs.push({ root: tab.root, path: tab.path, index: i });
  if (tab !== activeTab) { renderTabs(); return; }
  activeTab = null;
  const next = tabs[i] ?? tabs[i - 1];
  if (next) {
    await activateTab(next);
  } else {
    renderTabs();
    showEmpty();
  }
  reportDirty();
}

function cycleTab(step) {
  if (tabs.length < 2 || !activeTab) return;
  activateTab(tabs[(tabs.indexOf(activeTab) + step + tabs.length) % tabs.length]);
}

/**
 * Dragging a tab sideways reorders it. Dragging it well outside the tab bar and letting go moves it:
 * onto another MRAkdown window if dropped over one, otherwise into a new window (see dragOut).
 */
function startTabDrag(e, tab, el) {
  if (e.button !== 0 || e.target.closest('.tab-close')) return;
  activateTab(tab);
  el.setPointerCapture(e.pointerId);
  const startX = e.clientX;
  const startY = e.clientY;
  let dragging = false;
  let detached = false;

  const move = (ev) => {
    const dx = ev.clientX - startX;
    const dy = ev.clientY - startY;
    if (!dragging && Math.hypot(dx, dy) < 6) return;
    dragging = true;

    const bar = $('#tabbar').getBoundingClientRect();
    detached = ev.clientY < bar.top - 24 || ev.clientY > bar.bottom + 40
      || ev.clientX < 0 || ev.clientX > innerWidth;
    el.classList.toggle('detaching', detached);
    if (detached) {
      el.style.transform = `translate(${dx}px, ${dy}px)`;
      return;
    }
    el.style.transform = '';

    // Reorder by moving the neighbour across, not the dragged element (moving it would drop pointer capture).
    const prev = el.previousElementSibling;
    const next = el.nextElementSibling;
    if (prev && ev.clientX < prev.getBoundingClientRect().left + prev.offsetWidth / 2) el.after(prev);
    else if (next && ev.clientX > next.getBoundingClientRect().left + next.offsetWidth / 2) el.before(next);
    else return;
    tabs = [...$('#tabs').children].map((c) => c._tab);
  };

  const end = (ev) => {
    el.removeEventListener('pointermove', move);
    el.classList.remove('detaching');
    el.style.transform = '';
    // A new note can't move to another window until it has been saved.
    if (detached && ev.type === 'pointerup' && !tab.draft) dragOut(tab, ev.screenX, ev.screenY);
  };
  el.addEventListener('pointermove', move);
  el.addEventListener('pointerup', end, { once: true });
  el.addEventListener('pointercancel', end, { once: true });
}

const pendingDrags = new Map(); // drag id -> tab, until the host answers "dragOutResult"
let nextDragId = 1;

/**
 * Hands a dropped tab to the host. It moves the tab to the window under the pointer, or a new window;
 * the last tab only moves onto another window (which merges the two). The host then answers whether it moved.
 */
async function dragOut(tab, screenX, screenY) {
  if (tab === activeTab && editor && !(await editor.save())) return;
  const id = nextDragId++;
  pendingDrags.set(id, tab);
  const scroll = tab === activeTab ? $('#view').scrollTop : tab.scroll;
  post({ type: 'dragOut', id, root: tab.root, path: tab.path, scroll, x: screenX, y: screenY, last: tabs.length === 1 });
}

/** Index in the tab bar for a tab dropped at page x. */
function tabIndexAt(x) {
  const i = [...$('#tabs').children].findIndex((el) => {
    const r = el.getBoundingClientRect();
    return x < r.left + r.width / 2;
  });
  return i < 0 ? tabs.length : i;
}

function goBack() {
  const tab = activeTab;
  const entry = tab?.back.pop();
  if (!entry) return;
  tab.forward.push({ path: tab.path, scroll: $('#view').scrollTop });
  openNote(entry.path, { history: 'none', scrollTo: entry.scroll });
}

function goForward() {
  const tab = activeTab;
  const entry = tab?.forward.pop();
  if (!entry) return;
  tab.back.push({ path: tab.path, scroll: $('#view').scrollTop });
  openNote(entry.path, { history: 'none', scrollTo: entry.scroll });
}

/* ---------- Notes ---------- */

/** Opens a note in the active tab. history: 'push' records the previous note for Back. */
async function openNote(path, { hash = '', history = 'push', keepScroll = false, scrollTo } = {}) {
  if (!activeTab || activeTab.draft) return openInNewTab(activeTab?.root ?? currentRoot, path);
  // Leaving a note (or reloading it) with unsaved edits: save them first.
  if (editor && !(await editor.save())) return;

  const tab = activeTab;
  const view = $('#view');
  const previousScroll = view.scrollTop;
  const res = await fetch('/__api/note' + apiQuery(tab.root, path));
  if (tab !== activeTab) return; // switched tabs while loading

  if (!res.ok) {
    tab.path = path;
    tab.title = noteTitle(path);
    current = path;
    renderTabs();
    $('#content').innerHTML = `<div class="empty">Note not found: ${esc(path)}</div>`;
    markActive();
    if (editor) await editor.load(null);
    return;
  }

  const note = await res.json();
  if (history === 'push' && tab.path && tab.path !== note.path) {
    tab.back.push({ path: tab.path, scroll: previousScroll });
    tab.forward = [];
  }
  tab.path = note.path;
  tab.title = note.title;
  current = note.path;
  showNote(note);
  renderTabs();

  if (trees.has(tab.root) && expandAncestors(note.path) && !$('#filter').value) renderTree();
  else markActive();

  if (keepScroll) view.scrollTop = previousScroll;
  else if (scrollTo != null) view.scrollTop = scrollTo;
  else if (hash) scrollToHeading(decodeURIComponent(hash.slice(1)));
  else view.scrollTop = 0;

  if (editor && viewMode !== 'read') await editor.load({ root: tab.root, path: note.path });

  // Rendered before the folder scan finished: re-render once it has, so links to other folders resolve.
  if (!note.indexed) {
    (treeRequests.get(tab.root) ?? loadTree(tab.root)).then(() => {
      if (activeTab === tab && current === note.path) openNote(note.path, { history: 'none', keepScroll: true });
    });
  }
  return note;
}

function showEmpty() {
  current = null;
  document.body.classList.remove('plain-file');
  $('#content').innerHTML = '<div class="empty">Select a note</div>';
  document.title = 'MRAkdown';
  markActive();
  editor?.load(null);
}

/**
 * Renders a note ({ title, html }) into the reading/preview pane, or any other file as plain text
 * ({ markdown: false, text } — or binary / tooLarge when it can't be shown).
 */
function showNote(note) {
  const content = $('#content');
  // Markdown-only tools (formatting toolbar, shortcuts, image paste) are hidden for other files.
  document.body.classList.toggle('plain-file', note.markdown === false);
  content.classList.remove('viewer-wide');
  if (note.markdown === false && !note.binary && !note.tooLarge) {
    showInViewer(content, note);
  } else if (note.markdown === false) {
    content.innerHTML = textFileHtml(note);
    highlightCode(content);
  } else {
    content.innerHTML = `<div class="inline-title">${esc(note.title)}</div>${note.html}`;
    enhance(content);
  }
  document.title = `${document.body.classList.contains('dirty') ? '• ' : ''}${note.title} - MRAkdown`;
}

// Non-Markdown text files are shown by viewers.js (loaded on first use), which picks or lets the user
// choose how to show them: text, code, JSON, CSV or XML.
let viewers = null;

function showInViewer(content, note) {
  const host = { store, highlightCode };
  if (viewers) {
    viewers.renderViewer(content, note, host);
    return;
  }
  content.innerHTML = textFileHtml(note); // plain text until the viewer module has loaded
  import('/__app/viewers.js').then((module) => {
    viewers = module;
    // Still showing the same file? Then switch to its viewer.
    if (content.querySelector('.inline-title')?.textContent === note.title) viewers.renderViewer(content, note, host);
  });
}

function textFileHtml(note) {
  if (note.binary) return `<div class="empty">“${esc(note.title)}” isn't a text file, so it can't be shown.</div>`;
  if (note.tooLarge) return `<div class="empty">“${esc(note.title)}” is too large to open (over 20 MB).</div>`;
  const ext = note.title.includes('.') ? note.title.split('.').pop().toLowerCase() : '';
  // Highlight by file extension when highlight.js knows it; skip very large files to stay fast.
  const lang = ext && note.text.length < 300_000 ? `language-${ext}` : 'nohighlight';
  return `<div class="inline-title">${esc(note.title)}</div><pre class="text-file"><code class="${lang}">${esc(note.text)}</code></pre>`;
}

async function setViewMode(mode) {
  if (mode === viewMode) return;
  if (mode !== 'read' && !editor) {
    const { createEditor } = await import('/__app/editor.js');
    editor = createEditor({ view: $('#view'), showNote, setDirty, getMode: () => viewMode, saveDraft: saveDraftAs });
  }
  const leavingEdit = viewMode !== 'read' && mode === 'read';
  if (leavingEdit && activeTab?.draft) activeTab.draftText = editor.text();
  else if (leavingEdit && !(await editor.save())) return;

  viewMode = mode;
  document.body.dataset.mode = mode;
  for (const btn of document.querySelectorAll('#toolbar button[data-mode]')) {
    btn.classList.toggle('active', btn.dataset.mode === mode);
  }

  if (mode === 'read') {
    // Show the saved file as rendered by the normal note view (or a new note's text as a preview).
    if (activeTab?.draft) renderDraft(activeTab);
    else if (current) openNote(current, { history: 'none', keepScroll: true });
  } else {
    await editor.load(activeTab?.draft ? draftRef(activeTab)
      : current && activeTab ? { root: activeTab.root, path: current } : null);
    editor.renderPreview();
    editor.focus();
  }
}

function setDirty(dirty) {
  if (document.body.classList.contains('dirty') === dirty) return;
  document.body.classList.toggle('dirty', dirty);
  document.title = dirty ? `• ${document.title}` : document.title.replace(/^• /, '');
  reportDirty();
}

function scrollToHeading(text) {
  const wanted = text.trim().toLowerCase();
  const target = document.getElementById(text)
    ?? [...$('#content').querySelectorAll('h1, h2, h3, h4, h5, h6')]
      .find((h) => h.textContent.trim().toLowerCase() === wanted);
  target?.scrollIntoView({ block: 'start' });
}

function enhance(root) {
  // Obsidian callouts: a blockquote whose first line is [!type] Optional title
  for (const bq of root.querySelectorAll('blockquote')) {
    const first = bq.firstElementChild;
    if (first?.tagName !== 'P') continue;
    const m = first.innerHTML.match(/^\[!([\w-]+)\]([+-]?)[ \t]*([^\n]*?)(?:\n|<br>|$)/);
    if (!m) continue;

    const type = m[1].toLowerCase();
    first.innerHTML = first.innerHTML.slice(m[0].length);
    if (!first.innerHTML.trim()) first.remove();

    const callout = document.createElement('div');
    callout.className = 'callout';
    callout.style.setProperty('--c', CALLOUT_COLORS[type] ?? CALLOUT_COLORS.note);
    const title = document.createElement('div');
    title.className = 'callout-title';
    title.innerHTML = m[3].trim() || esc(type[0].toUpperCase() + type.slice(1));
    const body = document.createElement('div');
    body.className = 'callout-content';
    body.append(...bq.childNodes);
    callout.append(title, body);

    if (m[2]) {
      callout.classList.add('foldable');
      if (m[2] === '-') callout.classList.add('folded');
      title.onclick = () => callout.classList.toggle('folded');
    }
    bq.replaceWith(callout);
  }

  highlightCode(root);
}

let highlighter = null;

/** Highlights fenced code blocks. highlight.js (bundled locally) is only loaded once a note has code. */
async function highlightCode(root) {
  const blocks = root.querySelectorAll('pre code[class*="language-"]');
  if (!blocks.length) return;
  highlighter ??= new Promise((resolve) => {
    for (const [file, scheme] of [['hljs-github.min.css', 'light'], ['hljs-github-dark.min.css', 'dark']]) {
      const link = document.createElement('link');
      link.rel = 'stylesheet';
      link.href = `/__app/${file}`;
      link.media = `(prefers-color-scheme: ${scheme})`;
      document.head.append(link);
    }
    const script = document.createElement('script');
    script.src = '/__app/hljs.min.js';
    script.onload = () => resolve(window.hljs);
    script.onerror = () => resolve(null);
    document.head.append(script);
  });
  const hljs = await highlighter;
  if (!hljs) return;
  for (const code of blocks) {
    // Only languages highlight.js knows (e.g. a ".txt" file or an unknown fence language stays plain).
    const lang = [...code.classList].find((c) => c.startsWith('language-'))?.slice('language-'.length);
    if (code.isConnected && hljs.getLanguage(lang)) hljs.highlightElement(code);
  }
}

/** The note a link in the content points to: { root, path, hash }, or null for other links. */
function noteLink(a) {
  const href = a?.getAttribute('href');
  if (!href || href.startsWith('#') || a.classList.contains('unresolved')) return null;
  const url = new URL(href, location.href);
  // Note and file URLs look like /f/{root id}/{path}
  const m = url.origin === location.origin && url.pathname.match(/^\/f\/([^/]+)\/(.+)$/);
  if (!m) return null;
  const path = decodeURIComponent(m[2]);
  return /\.(md|markdown)$/i.test(path) ? { root: m[1], path, hash: url.hash } : null;
}

/** Link clicks in a note, with the same modifier keys as a browser (see clickTarget). */
function onContentLink(e, middle) {
  const a = e.target.closest('a');
  if (!a) return;
  e.preventDefault();
  const href = a.getAttribute('href');
  if (!href || a.classList.contains('unresolved')) return;
  if (href.startsWith('#')) {
    scrollToHeading(decodeURIComponent(href.slice(1)));
    return;
  }

  const note = noteLink(a);
  if (note) {
    openIn(note.root, note.path, clickTarget(e, middle), note.hash);
    return;
  }
  const url = new URL(href, location.href);
  const file = url.origin === location.origin && url.pathname.match(/^\/f\/([^/]+)\/(.+)$/);
  if (file) post({ type: 'openFile', root: file[1], path: decodeURIComponent(file[2]) });
  else if (url.origin !== location.origin) post({ type: 'open', url: url.href });
}
$('#content').addEventListener('click', (e) => onContentLink(e, false));
$('#content').addEventListener('auxclick', (e) => { if (e.button === 1) onContentLink(e, true); });
$('#content').addEventListener('mousedown', (e) => { if (e.button === 1 && e.target.closest('a')) e.preventDefault(); });
// Right-click on a link to another note: the same choices as in the folder view.
$('#content').addEventListener('contextmenu', (e) => {
  const note = noteLink(e.target.closest('a'));
  if (!note) return;
  e.preventDefault();
  showContextMenu(e.clientX, e.clientY, [
    { label: 'Open', action: () => openIn(note.root, note.path, 'current', note.hash) },
    { label: 'Open in new tab', hint: 'Ctrl+click', action: () => openIn(note.root, note.path, 'background') },
    { label: 'Open in new window', hint: 'Shift+click', action: () => openIn(note.root, note.path, 'window') },
  ]);
});

/* ---------- Shell ---------- */

const filter = $('#filter');
filter.addEventListener('input', renderTree);
filter.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    const first = $('#tree .tree-item.file');
    if (first) openIn(currentRoot, first.dataset.path, clickTarget(e));
  } else if (e.key === 'Escape') {
    filter.value = '';
    renderTree();
    filter.blur();
  }
});

/** Asks the host for a folder; it answers with an "openFolder" message. */
function openFolder() {
  post({ type: 'openFolder' });
}
/** Ctrl+O: the host shows an Open dialog; each chosen file (any type) opens as a tab. */
function openFile() {
  post({ type: 'openFileDialog', root: currentRoot });
}

$('#open-folder').onclick = openFolder;
$('#open-file').onclick = openFile;
$('#new-note').onclick = newNote;

async function openFolderTab(root) {
  const tree = trees.get(root) ?? await loadTree(root);
  await openInNewTab(root, homeNote(tree)?.path ?? null);
}

for (const btn of document.querySelectorAll('#toolbar button[data-mode]')) {
  btn.onclick = () => setViewMode(btn.dataset.mode);
}

/** F5 / Ctrl+R: a browser would reload the page and lose every tab, so reload the folder and note instead. */
async function reloadCurrent() {
  if (!currentRoot) return;
  await loadTree(currentRoot);
  if (!current) return;
  if (editor && viewMode !== 'read') editor.refresh();
  else openNote(current, { history: 'none', keepScroll: true });
}

// Shortcuts follow common browser conventions where one exists.
addEventListener('keydown', (e) => {
  if (e.altKey && e.key === 'ArrowLeft') { e.preventDefault(); goBack(); return; }
  if (e.altKey && e.key === 'ArrowRight') { e.preventDefault(); goForward(); return; }
  if (e.key === 'F5') { e.preventDefault(); reloadCurrent(); return; }
  if (!e.ctrlKey) return;
  const key = e.key.toLowerCase();
  if (key === 'p') { e.preventDefault(); filter.focus(); filter.select(); }
  else if (key === 'o') { e.preventDefault(); e.shiftKey ? openFolder() : openFile(); }
  else if (key === 's') { e.preventDefault(); editor?.save({ explicit: true }); }
  else if (key === 'r') { e.preventDefault(); reloadCurrent(); }
  else if (key === 't') { e.preventDefault(); e.shiftKey ? reopenClosedTab() : newEmptyTab(); }
  else if (key === 'n' && !e.shiftKey) { e.preventDefault(); newNote(); }
  else if (key === 'n') { e.preventDefault(); if (currentRoot) post({ type: 'openWindow', root: currentRoot, path: null }); }
  else if (key === 'w') { e.preventDefault(); if (e.shiftKey) post({ type: 'closeWindow' }); else if (activeTab) closeTab(activeTab); }
  else if (key === 'tab') { e.preventDefault(); cycleTab(e.shiftKey ? -1 : 1); }
  else if (key === 'pagedown') { e.preventDefault(); cycleTab(1); }
  else if (key === 'pageup') { e.preventDefault(); cycleTab(-1); }
  else if (/^[1-9]$/.test(key)) { e.preventDefault(); jumpToTab(Number(key)); }
  else if (key === 'e') {
    e.preventDefault();
    setViewMode(viewMode !== 'read' ? 'read' : e.shiftKey ? 'split' : 'edit');
  }
  else if (key === '\\') { e.preventDefault(); toggleSidebar(); }
});

// Double-clicking the empty part of the tab bar opens a new tab, like in a browser.
$('#tabs').addEventListener('dblclick', (e) => { if (e.target === e.currentTarget) newEmptyTab(); });

// Mouse back/forward buttons
addEventListener('mouseup', (e) => {
  if (e.button === 3) { e.preventDefault(); goBack(); }
  else if (e.button === 4) { e.preventDefault(); goForward(); }
});

/* ---------- Accent colour ---------- */

// Each preset has a darker shade for light mode and a brighter one for dark mode, so links stay readable.
const ACCENTS = [
  { name: 'Orange', light: '#c2410c', dark: '#ff8a3d' },
  { name: 'Purple', light: '#7c3aed', dark: '#a88bfa' },
  { name: 'Blue', light: '#2563eb', dark: '#60a5fa' },
  { name: 'Teal', light: '#0f766e', dark: '#2dd4bf' },
  { name: 'Green', light: '#15803d', dark: '#4ade80' },
  { name: 'Pink', light: '#be185d', dark: '#f472b6' },
  { name: 'Red', light: '#b91c1c', dark: '#f87171' },
];

/** Applies and remembers an accent ({ light, dark, custom? }); null restores the default orange. */
function applyAccent(accent) {
  const style = document.documentElement.style;
  if (accent) {
    style.setProperty('--accent-light', accent.light);
    style.setProperty('--accent-dark', accent.dark);
  } else {
    style.removeProperty('--accent-light');
    style.removeProperty('--accent-dark');
  }
  store.set('accent', accent);
}

let accentPanel = null;

function closeAccentPanel() {
  accentPanel?.remove();
  accentPanel = null;
}

function toggleAccentPanel() {
  if (accentPanel) { closeAccentPanel(); return; }

  const saved = store.get('accent', null);
  const panel = document.createElement('div');
  panel.id = 'settings';
  panel.setAttribute('role', 'dialog');
  panel.setAttribute('aria-label', 'Accent colour');
  panel.innerHTML = `
    <div class="settings-title">Accent colour</div>
    <div class="swatches">
      ${ACCENTS.map((a, i) => `<button class="swatch" data-i="${i}" title="${a.name}" aria-label="${a.name}"
        style="--c-light:${a.light};--c-dark:${a.dark}"></button>`).join('')}
      <label class="swatch custom" title="Custom colour"><input type="color" aria-label="Custom colour"></label>
    </div>
    <button class="settings-reset">Reset to default</button>`;

  const swatches = [...panel.querySelectorAll('.swatch')];
  const customInput = panel.querySelector('input[type="color"]');
  customInput.value = saved?.custom ?? ACCENTS[0].dark;
  const markActive = (accent) => {
    const index = accent?.custom ? ACCENTS.length : Math.max(0, ACCENTS.findIndex((a) => a.dark === accent?.dark));
    swatches.forEach((s, i) => s.classList.toggle('active', i === index));
  };
  markActive(saved);

  panel.querySelectorAll('button.swatch').forEach((btn) => {
    btn.onclick = () => {
      const i = Number(btn.dataset.i);
      const accent = i === 0 ? null : { light: ACCENTS[i].light, dark: ACCENTS[i].dark };
      applyAccent(accent);
      markActive(accent);
    };
  });
  customInput.addEventListener('input', () => {
    // A custom pick is used as-is in dark mode and darkened for light mode.
    const c = customInput.value;
    const accent = { light: `color-mix(in oklab, ${c} 72%, black)`, dark: c, custom: c };
    applyAccent(accent);
    markActive(accent);
  });
  panel.querySelector('.settings-reset').onclick = () => {
    applyAccent(null);
    markActive(null);
  };

  $('#main').append(panel);
  accentPanel = panel;
}

$('#accent-button').onclick = toggleAccentPanel;
addEventListener('pointerdown', (e) => {
  if (accentPanel && !accentPanel.contains(e.target) && !$('#accent-button').contains(e.target)) closeAccentPanel();
});
addEventListener('keydown', (e) => {
  if (e.key === 'Escape') closeAccentPanel();
});

function setFormatToolbar(visible) {
  document.body.classList.toggle('hide-format', !visible);
  $('#format-toggle').setAttribute('aria-pressed', String(visible));
  store.set('formatHidden', !visible);
}
$('#format-toggle').onclick = () => setFormatToolbar(document.body.classList.contains('hide-format'));

function toggleSidebar() {
  store.set('sidebarHidden', document.body.classList.toggle('side-hidden'));
}
for (const btn of document.querySelectorAll('.toggle-side')) btn.onclick = toggleSidebar;

/* ---------- Messages from the host ---------- */

window.chrome?.webview?.addEventListener('message', async (e) => {
  const msg = e.data;
  switch (msg?.type) {
    case 'saveAndClose': {
      // The window is closing with unsaved edits; the host closes once we confirm.
      // New notes with text ask Save / Don't save / Cancel first; Cancel keeps the window open.
      for (const tab of tabs.filter((t) => t.draft)) {
        if (!(await confirmCloseDraft(tab))) {
          post({ type: 'closeCancelled' });
          return;
        }
      }
      if (await editor?.save() ?? true) post({ type: 'closeReady' });
      else post({ type: 'closeCancelled' });
      break;
    }
    case 'reply':
      hostCalls.get(msg.id)?.(msg.value);
      hostCalls.delete(msg.id);
      break;
    case 'changed':
      await onRootChanged(msg.root);
      break;
    case 'openTab': {
      // A file opened from Explorer, or a tab dragged in from another window (then x and scroll are set).
      rootNames.set(msg.root, msg.rootName);
      const existing = msg.path && tabs.find((t) => t.root === msg.root && t.path === msg.path);
      if (existing) {
        activateTab(existing);
      } else if (msg.x != null) {
        const tab = createTab(msg.root, msg.path);
        tab.scroll = msg.scroll ?? 0;
        tabs.splice(tabIndexAt(msg.x), 0, tab);
        activateTab(tab);
      } else {
        openInNewTab(msg.root, msg.path);
      }
      break;
    }
    case 'dragOutResult': {
      const tab = pendingDrags.get(msg.id);
      pendingDrags.delete(msg.id);
      if (tab && msg.moved) closeTab(tab, { remember: false });
      break;
    }
    case 'openFolder':
      rootNames.set(msg.root, msg.rootName);
      openFolderTab(msg.root);
      break;
  }
});

/** Files in a root folder changed on disk: refresh its tree, and the open note if it is in that folder. */
async function onRootChanged(root) {
  if (!trees.has(root)) return;
  await loadTree(root);
  if (!activeTab || activeTab.root !== root || !current) return;
  // While editing, refresh the editor instead of re-opening the note, so the caret stays put.
  if (editor && viewMode !== 'read') editor.refresh();
  else openNote(current, { history: 'none', keepScroll: true });
}

// Sidebar resizing
const resizer = $('#resizer');
const setSideWidth = (w) => document.body.style.setProperty('--side-w', `${w}px`);
resizer.addEventListener('pointerdown', (e) => {
  resizer.setPointerCapture(e.pointerId);
  resizer.classList.add('dragging');
  const move = (ev) => setSideWidth(Math.min(600, Math.max(160, ev.clientX)));
  resizer.addEventListener('pointermove', move);
  resizer.addEventListener('pointerup', () => {
    resizer.removeEventListener('pointermove', move);
    resizer.classList.remove('dragging');
    store.set('sideWidth', $('#sidebar').offsetWidth);
  }, { once: true });
});

(async () => {
  setSideWidth(store.get('sideWidth', 260));
  document.body.classList.toggle('side-hidden', store.get('sidebarHidden', false));
  setFormatToolbar(!store.get('formatHidden', false));
  // Always start in read mode so opening a file never waits for the editor.
  document.body.dataset.mode = 'read';
  $('#toolbar button[data-mode="read"]').classList.add('active');

  try {
    const params = new URLSearchParams(location.search);
    const root = params.get('r');
    const start = params.get('n');
    currentRoot = root;

    // Show the requested note first; the folder tree loads alongside it.
    const treeLoaded = loadTree(root);
    if (start) {
      const tab = createTab(root, start);
      tabs.push(tab);
      activeTab = tab;
      renderTabs();
      await openNote(start, { hash: location.hash, history: 'none' });
    } else {
      const home = homeNote(await treeLoaded);
      const tab = createTab(root, home?.path ?? null);
      tabs.push(tab);
      activeTab = tab;
      renderTabs();
      if (home) await openNote(home.path, { history: 'none' });
      else showEmpty();
    }
  } finally {
    // Lets the host send files that were opened while this window was starting.
    post({ type: 'ready' });
  }
})();
