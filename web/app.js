const $ = (sel) => document.querySelector(sel);
// The host app: WebView2 on Windows; on Linux the WebKitGTK host posts to a script message handler
// and answers through a "host-message" event (see MainWindow.cs in MRAkdown.Linux).
const hostBridge = window.chrome?.webview ?? {
  postMessage: (msg) => window.webkit?.messageHandlers?.host?.postMessage(msg),
  addEventListener: (type, listener) => window.addEventListener('host-message', (e) => listener({ data: e.detail })),
};
const post = (msg) => hostBridge.postMessage(msg);
/** True for URLs served by the host. Compares scheme and host: the Linux host's custom scheme has an opaque origin. */
const isAppUrl = (url) => url.protocol === location.protocol && url.host === location.host;
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

// Tabs, view modes and editors belong to panes (see "Panes"); the folder panel shows the active pane's folder.
let currentRoot = null;  // root folder id shown in the sidebar (the active pane's active tab's)
const trees = new Map();     // root id -> folder tree
const rootNames = new Map(); // root id -> folder name
// Linux window buttons, which sit at the ends of the panes' tab bars (see "Window title bar").
const windowButtons = { left: null, right: null };
/** Path of the file shown in the active pane, marked in the folder panel. */
const currentPath = () => activePane?.current ?? null;

const apiQuery = (root, path) =>
  `?r=${encodeURIComponent(root)}` + (path != null ? `&n=${encodeURIComponent(path)}` : '');
const noteTitle = (path) => path.slice(path.lastIndexOf('/') + 1).replace(/\.(md|markdown)$/i, '');
const isMarkdownPath = (path) => /\.(md|markdown)$/i.test(path);
const extOf = (path) => (/\.([^./]+)$/.exec(path)?.[1] ?? '').toLowerCase();
const homeNote = (tree) => tree?.children.find((n) => !n.children && isMarkdownPath(n.path) && /^(readme|index|home)$/i.test(n.name));

// File types with their own viewer in viewers.js; any other text file opens as text or code.
const VIEWER_KIND_BY_EXT = {
  txt: 'text', log: 'text',
  json: 'json',
  csv: 'csv', tsv: 'csv',
  xml: 'xml', config: 'xml', csproj: 'xml', props: 'xml', targets: 'xml', xaml: 'xml',
  resx: 'xml', xsd: 'xml', xsl: 'xml', xslt: 'xml', svg: 'xml', plist: 'xml',
};

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
  const show = treeShow;
  // The expanded folders: for a very large folder the host only scans those (see NoteIndex.IsPartial).
  const open = [...expandedFor(root)].map((dir) => '&open=' + encodeURIComponent(dir)).join('');
  const res = await fetch('/__api/tree' + apiQuery(root) + treeFilesQuery() + open);
  if (!res.ok) return null;
  const tree = await res.json();
  // The choice of files changed while this was loading; the newer request fills in the tree.
  if (show !== treeShow) return tree;
  trees.set(root, tree);
  rootNames.set(root, tree.name);
  for (const t of allTabs()) if (t.root === root && !t.path && !t.draft && !t.diff) t.title = tree.name;
  renderAllTabs();
  if (root === currentRoot) {
    if (currentPath()) expandAncestors(currentPath());
    renderTree();
  }
  return tree;
}

// Which files the folder panel lists: notes only, notes and files with their own viewer, or everything.
// The host filters the tree (see TreeFiles in NoteServer.cs), so big folders only send what is shown.
const TREE_SHOW = { markdown: 'Markdown only', supported: 'Supported formats', all: 'All files' };
let treeShow = TREE_SHOW[store.get('treeShow', 'markdown')] ? store.get('treeShow', 'markdown') : 'markdown';

/** The "files" parameter for /__api/tree: which files the host lists (none: Markdown only, "*": all). */
function treeFilesQuery() {
  if (treeShow === 'all') return '&files=*';
  if (treeShow === 'supported') return '&files=' + encodeURIComponent(Object.keys(VIEWER_KIND_BY_EXT).join(','));
  return '';
}

function setTreeShow(value) {
  treeShow = value;
  store.set('treeShow', value);
  $('#tree-show').classList.toggle('active', value !== 'markdown');
  // Every folder's tree lists other files now: reload this one, and the others when they're shown again.
  trees.clear();
  if (currentRoot) loadTree(currentRoot);
}

$('#tree-show').classList.toggle('active', treeShow !== 'markdown');
$('#tree-show').onclick = (e) => {
  const r = e.currentTarget.getBoundingClientRect();
  showContextMenu(r.left, r.bottom + 4, Object.entries(TREE_SHOW).map(([value, label]) => ({
    label,
    checked: value === treeShow,
    action: () => setTreeShow(value),
  })));
};

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
    if (!matches.length) nav.innerHTML = `<div class="tree-empty">No matching files</div>`;
  } else {
    nav.append(...tree.children.map((n) => buildNode(n, root)));
    if (!tree.children.length) {
      const what = { markdown: 'Markdown files', supported: 'supported files', all: 'files' }[treeShow];
      nav.innerHTML = `<div class="tree-empty">No ${what} in this folder</div>`;
    }
  }
  markActive();
}

function fileItem(n) {
  const el = document.createElement('div');
  el.className = 'tree-item file' + (n.path === currentPath() ? ' active' : '');
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
      { label: 'Open to the side', action: () => openIn(root, n.path, 'side') },
      { label: 'Open in new tab', hint: 'Ctrl+click', action: () => openIn(root, n.path, 'background') },
      { label: 'Open in new window', hint: 'Shift+click', action: () => openIn(root, n.path, 'window') },
      ...compareItems(root, n.path, activePane?.activeTab, 'open now'),
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

/** Opens a note in the 'current' tab, a new 'tab', a 'background' tab, the other pane ('side') or a new 'window'. */
function openIn(root, path, target, hash = '') {
  const pane = activePane;
  const tab = pane.activeTab;
  if (target === 'window') post({ type: 'openWindow', root, path });
  else if (target === 'side') openInPane(ensureOtherPane(pane), root, path, hash);
  else if (target === 'tab' || target === 'background') openInNewTab(root, path, { background: target === 'background' });
  // Never replace an unsaved new note or a comparison: open next to it instead.
  else if (!tab || tab.root !== root || tab.draft || tab.diff) openInNewTab(root, path);
  else openNote(pane, path, { hash });
}

/* ---------- Context menu ---------- */

let contextMenu = null;

function closeContextMenu() {
  contextMenu?.remove();
  contextMenu = null;
}

let lastMenuPoint = { x: 0, y: 0 }; // where the last menu opened, for a follow-up menu (e.g. the commit list)

/** Shows a small menu at (x, y). items: [{ label, hint?, title?, disabled?, action }] */
function showContextMenu(x, y, items) {
  closeContextMenu();
  lastMenuPoint = { x, y };
  const menu = document.createElement('div');
  menu.className = 'context-menu';
  menu.setAttribute('role', 'menu');
  for (const item of items) {
    const btn = document.createElement('button');
    // Items with "checked" are choices: a check mark shows the current one.
    const isChoice = item.checked !== undefined;
    btn.setAttribute('role', isChoice ? 'menuitemradio' : 'menuitem');
    if (isChoice) btn.setAttribute('aria-checked', String(item.checked));
    const check = isChoice ? `<span class="menu-check">${item.checked ? '✓' : ''}</span>` : '';
    btn.innerHTML = `<span>${check}${esc(item.label)}</span>${item.hint ? `<kbd>${esc(item.hint)}</kbd>` : ''}`;
    if (item.title) btn.title = item.title;
    btn.disabled = Boolean(item.disabled);
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
  (menu.querySelector('button:not(:disabled)') ?? menu.querySelector('button')).focus({ preventScroll: true });
}

addEventListener('pointerdown', (e) => {
  if (contextMenu && !contextMenu.contains(e.target)) closeContextMenu();
});
addEventListener('keydown', (e) => {
  if (e.key === 'Escape') closeContextMenu();
});
addEventListener('blur', closeContextMenu);
addEventListener('wheel', closeContextMenu, { passive: true });

const scanRequests = new Set(); // "root/folder" being scanned for the tree, so each is only asked for once

function buildNode(n, root) {
  if (!n.children) return fileItem(n);

  const expanded = expandedFor(root);
  const el = document.createElement('div');
  el.className = 'tree-item folder' + (expanded.has(n.path) ? '' : ' collapsed');
  el.innerHTML = `<svg class="chev" viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2"><path d="m6 9 6 6 6-6"/></svg><span>${esc(n.name)}</span>`;
  const children = document.createElement('div');
  children.className = 'tree-children';
  // Build a folder's contents only once it is opened, so huge folders render quickly. In a very large folder the
  // host hasn't scanned an unopened folder yet (n.unscanned): ask for the tree again, now with this folder open.
  const fill = () => {
    if (children.hasChildNodes()) return;
    if (!n.unscanned) {
      children.append(...n.children.map((c) => buildNode(c, root)));
    } else {
      children.innerHTML = '<div class="tree-empty">Loading…</div>';
      const key = `${root}/${n.path}`;
      if (!scanRequests.has(key)) {
        scanRequests.add(key);
        loadTree(root).finally(() => scanRequests.delete(key));
      }
    }
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
    el.classList.toggle('active', el.dataset.path === currentPath());
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

/* ---------- Panes ---------- */

// The window shows one or two panes side by side. Each has its own tabs, view mode, editor and history:
// { el, tabbarEl, tabsEl, viewEl, contentEl, tabs, activeTab, current, mode, editor, tabEls, openedInBackground }
// current is the path of the file shown in its active tab; mode is 'read' | 'edit' | 'split' | 'live'. The editor module is
// only imported on a pane's first switch away from 'read'. The folder panel, window title and keyboard shortcuts
// follow the active pane: the one last clicked or typed in.
const panes = [];
let activePane = null;
const MAX_PANES = 2;

const paneOf = (tab) => panes.find((p) => p.tabs.includes(tab)) ?? null;
const otherPane = (pane) => panes.find((p) => p !== pane) ?? null;
/** All tabs, in every pane. */
const allTabs = () => panes.flatMap((p) => p.tabs);

let paneSplit = store.get('paneSplit', 0.5); // the left pane's share of the width, with two panes
// The window's own buttons, which layoutPanes puts in the tab bars (kept here: a pane that closes takes its DOM with it).
const showSideButton = $('#show-side');
const settingsButton = $('#settings-button');
const paneResizer = document.createElement('div');
paneResizer.className = 'pane-resizer';
paneResizer.title = 'Drag to resize, double-click to reset';

/** Adds an empty pane at index (0 = left). */
function createPane(index = panes.length) {
  const el = $('#pane-template').content.firstElementChild.cloneNode(true);
  const pane = {
    el,
    tabbarEl: el.querySelector('.tabbar'),
    tabsEl: el.querySelector('.tabs'),
    viewEl: el.querySelector('.view'),
    contentEl: el.querySelector('.content'),
    tabs: [],
    activeTab: null,
    current: null,
    mode: 'read',
    editor: null,
    tabEls: new Map(), // tab -> element
    openedInBackground: 0,
  };
  panes.splice(index, 0, pane);

  for (const btn of el.querySelectorAll('.toolbar button[data-mode]')) btn.onclick = () => setViewMode(pane, btn.dataset.mode);
  el.querySelector('.toolbar button[data-mode="read"]').classList.add('active');
  el.querySelector('.format-toggle').onclick = () => setFormatToolbar(document.body.classList.contains('hide-format'));
  el.querySelector('.format-toggle').setAttribute('aria-pressed', String(!document.body.classList.contains('hide-format')));
  // Clicking or typing in a pane makes it the active one (capture: before the click itself is handled).
  el.addEventListener('pointerdown', () => focusPane(pane), true);
  el.addEventListener('focusin', () => focusPane(pane));
  el.querySelector('.new-tab').onclick = () => newEmptyTab(pane);
  // Double-clicking the empty part of the tab bar opens a new tab too, on Windows. On Linux the tab bar is also the
  // window's title bar, so a double-click there does what the desktop does for title bars (see "Window title bar").
  pane.tabbarEl.addEventListener('dblclick', (e) => {
    if (!window.hostWindowControls && (e.target === pane.tabbarEl || e.target === pane.tabsEl)) newEmptyTab(pane);
  });

  const content = pane.contentEl;
  content.addEventListener('click', (e) => onContentLink(pane, e, false));
  content.addEventListener('auxclick', (e) => { if (e.button === 1) onContentLink(pane, e, true); });
  content.addEventListener('mousedown', (e) => { if (e.button === 1 && e.target.closest('a')) e.preventDefault(); });
  // Right-click on a link to another note: the same choices as in the folder view.
  content.addEventListener('contextmenu', (e) => {
    const note = noteLink(e.target.closest('a'));
    if (!note) return;
    e.preventDefault();
    showContextMenu(e.clientX, e.clientY, [
      { label: 'Open', action: () => openIn(note.root, note.path, 'current', note.hash) },
      { label: 'Open to the side', action: () => openIn(note.root, note.path, 'side', note.hash) },
      { label: 'Open in new tab', hint: 'Ctrl+click', action: () => openIn(note.root, note.path, 'background') },
      { label: 'Open in new window', hint: 'Shift+click', action: () => openIn(note.root, note.path, 'window') },
    ]);
  });

  applyShortcutHints(el);
  layoutPanes();
  return pane;
}

/** Closes an empty pane; the other one takes the whole width. */
function removePane(pane) {
  const i = panes.indexOf(pane);
  if (i < 0 || panes.length === 1) return;
  panes.splice(i, 1);
  pane.el.remove();
  if (activePane === pane) activePane = null;
  layoutPanes();
  focusPane(panes[0]);
  syncSidebar();
}

/** Puts the panes (and the divider between two) in order, and the window's own buttons in their tab bars. */
function layoutPanes() {
  const box = $('#panes');
  const wanted = panes.length > 1 ? [panes[0].el, paneResizer, panes[1].el] : [panes[0].el];
  if (panes.length === 1) paneResizer.remove();
  // Only move what is out of place: moving a pane would reset its scroll position.
  wanted.forEach((node, i) => { if (box.children[i] !== node) box.insertBefore(node, box.children[i] ?? null); });
  panes[0].el.style.flex = panes.length > 1 ? `0 0 ${paneSplit * 100}%` : '';
  for (const p of panes) p.el.classList.toggle('focused', panes.length > 1 && p === activePane);

  // Show folder panel (and, on Linux, the left window buttons) at the far left; the Settings button and the right
  // window buttons at the far right.
  const firstBar = panes[0].tabbarEl;
  firstBar.prepend(showSideButton);
  if (windowButtons.left) firstBar.prepend(windowButtons.left);
  panes.at(-1).el.querySelector('.unsaved').after(settingsButton);
  if (windowButtons.right) panes.at(-1).tabbarEl.append(windowButtons.right);
}

paneResizer.addEventListener('pointerdown', (e) => {
  e.preventDefault();
  paneResizer.setPointerCapture(e.pointerId);
  paneResizer.classList.add('dragging');
  const box = $('#panes').getBoundingClientRect();
  const move = (ev) => {
    paneSplit = Math.min(0.8, Math.max(0.2, (ev.clientX - box.left) / box.width));
    panes[0].el.style.flex = `0 0 ${paneSplit * 100}%`;
  };
  paneResizer.addEventListener('pointermove', move);
  paneResizer.addEventListener('pointerup', () => {
    paneResizer.removeEventListener('pointermove', move);
    paneResizer.classList.remove('dragging');
    store.set('paneSplit', paneSplit);
  }, { once: true });
});
paneResizer.addEventListener('dblclick', () => {
  paneSplit = 0.5;
  panes[0].el.style.flex = '0 0 50%';
  store.set('paneSplit', paneSplit);
});

/** Makes a pane the active one: the folder panel, window title and shortcuts follow it. */
function focusPane(pane) {
  if (!pane || activePane === pane) return;
  activePane = pane;
  for (const p of panes) p.el.classList.toggle('focused', panes.length > 1 && p === pane);
  syncSidebar();
}

/** Shows the active pane's folder in the folder panel, marks its file there, and titles the window after it. */
function syncSidebar() {
  const root = activePane?.activeTab?.root ?? currentRoot;
  if (root !== currentRoot) {
    currentRoot = root;
    renderTree();
    if (root && !trees.has(root)) loadTree(root);
  } else {
    markActive();
  }
  updateTitle();
}

function updateTitle() {
  const pane = activePane;
  const tab = pane?.activeTab;
  const shown = tab && (pane.current || tab.draft || tab.diff);
  const dirty = pane?.el.classList.contains('dirty') ? '• ' : '';
  document.title = shown ? `${dirty}${tab.title} - MRAkdown` : 'MRAkdown';
}

/* ---------- Tabs ---------- */

// Each tab shows one file (or nothing yet) from one root folder; tabs can come from different folders.
// A tab: { root, path, title, scroll, back: [{ path, scroll }], forward: [...] }, plus { draft, draftText } for a new
// note that hasn't been saved yet, or { diff } for a comparison of two files (see "Comparing files").

function createTab(root, path) {
  return { root, path, title: path ? noteTitle(path) : rootNames.get(root) ?? '', scroll: 0, back: [], forward: [] };
}

/** Updates a pane's tab bar in place (elements are reused, so a tab being dragged keeps its pointer capture). */
function renderTabs(pane) {
  for (const [tab, el] of pane.tabEls) {
    if (!pane.tabs.includes(tab)) { el.remove(); pane.tabEls.delete(tab); }
  }
  pane.tabs.forEach((tab, i) => {
    let el = pane.tabEls.get(tab);
    if (!el) { el = tabElement(tab); pane.tabEls.set(tab, el); }
    el.classList.toggle('active', tab === pane.activeTab);
    el.setAttribute('aria-selected', String(tab === pane.activeTab));
    el.querySelector('.tab-title').textContent = tab.title || 'New tab';
    el.classList.toggle('has-edits', Boolean(tab.pending) || (tab === pane.activeTab && pane.el.classList.contains('dirty')));
    el.title = tab.diff ? diffDescription(tab.diff) : [rootNames.get(tab.root), tab.path].filter(Boolean).join(' / ');
    if (pane.tabsEl.children[i] !== el) pane.tabsEl.insertBefore(el, pane.tabsEl.children[i] ?? null);
  });
  pane.tabEls.get(pane.activeTab)?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
}

const renderAllTabs = () => panes.forEach(renderTabs);

function tabElement(tab) {
  const el = document.createElement('div');
  el.className = 'tab';
  el.setAttribute('role', 'tab');
  el.innerHTML = `<span class="tab-title"></span>
    <button class="tab-close" data-shortcut="closeTab" data-hint="Close ({keys})" aria-label="Close tab">
      <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="M6 6l12 12M18 6 6 18"/></svg>
    </button>`;
  el._tab = tab;
  applyShortcutHints(el);
  el.querySelector('.tab-close').onclick = (e) => { e.stopPropagation(); closeTab(tab); };
  el.addEventListener('mousedown', (e) => { if (e.button === 1) e.preventDefault(); }); // no autoscroll
  el.addEventListener('auxclick', (e) => { if (e.button === 1) closeTab(tab); });
  el.addEventListener('pointerdown', (e) => startTabDrag(e, tab, el));
  el.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    showContextMenu(e.clientX, e.clientY, tabMenu(tab));
  });
  return el;
}

/** Right-click on a tab. */
function tabMenu(tab) {
  const pane = paneOf(tab);
  const other = otherPane(pane);
  const items = [];
  const isFile = tab.path && !tab.draft && !tab.diff;
  if (isFile) items.push({ label: other ? 'Open in other pane' : 'Open to the side', action: () => openInPane(ensureOtherPane(pane), tab.root, tab.path) });
  if (other || pane.tabs.length > 1) {
    items.push({ label: other ? 'Move to other pane' : 'Move to the side', action: () => moveTab(tab, ensureOtherPane(pane)) });
  }
  if (isFile) items.push(...compareItems(tab.root, tab.path, other?.activeTab, 'other pane'));
  items.push({ label: 'Close', hint: shortcutHint('closeTab'), action: () => closeTab(tab) });
  return items;
}

async function activateTab(tab) {
  const pane = paneOf(tab);
  if (!pane) return;
  focusPane(pane);
  if (tab === pane.activeTab) return;
  if (!(await leaveTab(pane))) return;
  pane.activeTab = tab;
  pane.openedInBackground = 0;
  renderTabs(pane);
  syncSidebar();
  await showTab(pane);
  reportDirty();
}

/** Before a pane shows another tab: keeps a new note's text in its tab, and saves a file's edits. False if saving failed. */
async function leaveTab(pane) {
  const tab = pane.activeTab;
  if (!tab) return true;
  if (tab.draft) tab.draftText = pane.editor?.text() ?? tab.draftText;
  else if (pane.editor && !tab.diff && !(await keepOrSave(pane, tab))) return false;
  tab.scroll = pane.viewEl.scrollTop;
  return true;
}

/** Shows a pane's active tab. */
async function showTab(pane) {
  const tab = pane.activeTab;
  pane.el.classList.toggle('diff', Boolean(tab?.diff));
  if (!tab) showEmpty(pane);
  else if (tab.diff) await showDiff(pane, tab);
  else if (tab.draft) await showDraft(pane, tab);
  else if (tab.path) await openNote(pane, tab.path, { history: 'none', scrollTo: tab.scroll });
  else showEmpty(pane);
}

/** Inserts a tab into a pane after its active tab (background tabs line up after it, like in a browser). */
function insertTab(pane, tab, { background = false } = {}) {
  const after = pane.activeTab ? pane.tabs.indexOf(pane.activeTab) + 1 : pane.tabs.length;
  pane.tabs.splice(after + (background ? pane.openedInBackground++ : 0), 0, tab);
}

/* ---------- New notes ---------- */

// A new note lives only in its tab ({ draft: true, draftText }) until its first save,
// which asks where to save it (Ctrl+S, or "Save" when closing it).

/** Ctrl+N: a new, unsaved note in a new tab, opened for editing. */
async function newNote(pane = activePane) {
  if (!currentRoot) return;
  const tab = createTab(currentRoot, null);
  tab.draft = true;
  tab.draftText = '';
  tab.title = 'Untitled';
  insertTab(pane, tab);
  await activateTab(tab);
}

const draftRef = (tab) => ({ root: tab.root, draft: true, text: tab.draftText ?? '' });
function draftText(tab) {
  const pane = paneOf(tab);
  return (pane && tab === pane.activeTab && pane.editor ? pane.editor.text() : tab.draftText) ?? '';
}

/** Shows a new note: in the editor (switching to Edit mode if needed), or as a preview in Read mode. */
async function showDraft(pane, tab) {
  pane.current = null;
  pane.el.classList.remove('plain-file'); // new notes are always Markdown
  if (pane === activePane) { markActive(); updateTitle(); }
  if (pane.mode === 'read' && !tab.draftText) {
    await setViewMode(pane, 'edit');
  } else if (pane.mode === 'read') {
    await renderDraft(pane, tab);
  } else {
    await pane.editor.load(draftRef(tab));
    pane.editor.renderPreview();
    pane.editor.focus();
  }
}

async function renderDraft(pane, tab) {
  const res = await fetch('/__api/render' + apiQuery(tab.root, ''), { method: 'POST', body: tab.draftText ?? '' });
  if (res.ok && pane.activeTab === tab) showNote(pane, { ...(await res.json()), title: tab.title });
}

/** A file name suggestion from the first heading or line of a new note. */
function suggestName(text) {
  const first = text.split('\n').map((l) => l.replace(/^#+\s*/, '').trim()).find(Boolean) ?? '';
  return first.replace(/[\\/:*?"<>|#^[\]]/g, '').slice(0, 60).trim() || 'Untitled';
}

/** First save of a pane's active new note: the host asks where to save it. Resolves to { root, path } or null. */
async function saveDraftAs(pane, text) {
  const tab = pane.activeTab;
  const saved = await callHost('saveAs', { root: tab.root, text, name: suggestName(text) });
  if (!saved) return null;

  rootNames.set(saved.root, saved.rootName);
  tab.draft = false;
  delete tab.draftText;
  tab.root = saved.root;
  tab.path = saved.path;
  tab.title = noteTitle(saved.path);
  if (pane.activeTab === tab) {
    pane.current = saved.path;
    if (pane === activePane) syncSidebar();
    loadTree(saved.root);
  }
  renderTabs(pane);
  return { root: saved.root, path: saved.path };
}

/**
 * Closing a new note that has text: asks Save / Don't save / Cancel.
 * Resolves true when it's fine to close it (saved or discarded).
 */
async function confirmCloseDraft(tab) {
  if (!draftText(tab).trim()) return true;
  const pane = paneOf(tab);
  if (tab !== pane.activeTab) await activateTab(tab);
  const answer = await callHost('askSave', { title: tab.title });
  if (answer === 'cancel') return false;
  if (answer === 'no') return true;
  // Saving goes through the editor, which a pane only has once it has been in Edit mode.
  if (!pane.editor) await setViewMode(pane, 'edit');
  return pane.editor.save({ explicit: true });
}

/* ---------- Saving ---------- */

// Unsaved edits stay in their tab until you save them (Ctrl+S) or they'd be lost or leave the window: closing the tab
// or window, another file in the tab, moving it to another window; then you're asked Save / Don't save / Cancel. While
// its pane's editor has another file or none, a tab keeps them as { pending }, and shows a dot. With "Save
// automatically" turned on in Settings, a file's edits are saved instead whenever you leave it: another tab, file or
// mode, or closing.
let autoSave = store.get('autoSave', false);

const fileRef = (tab) => ({ root: tab.root, path: tab.path });

/**
 * Writes a file's text. edits: { text, saved, crlf }, saved being the text the file had when it was opened or last
 * saved. If it has changed on disk since (another program, or the same file saved from the other pane), asks before
 * overwriting it. Resolves false if the file wasn't saved.
 */
async function writeFile(file, { text, saved, crlf }) {
  const query = apiQuery(file.root, file.path);
  const onDisk = await fetch('/__api/source' + query);
  if (onDisk.ok && (await onDisk.text()).replace(/\r\n/g, '\n') !== saved) {
    const overwrite = await callHost('confirm', {
      title: 'File changed on disk',
      message: `“${fileName(file.path)}” was changed since you opened it, by another program or in another tab. Save your version over it?`,
      yes: '_Save Anyway',
    });
    if (!overwrite) return false;
  }
  const res = await fetch('/__api/save' + query, { method: 'POST', body: crlf ? text.replace(/\n/g, '\r\n') : text });
  if (!res.ok) {
    alert(`Could not save ${file.path}:\n${await res.text()}`);
    return false;
  }
  return true;
}

/** A file tab's unsaved edits, in its pane's editor or kept in the tab; null if it has none. */
function unsavedEdits(tab) {
  if (!tab.path || tab.draft || tab.diff) return null;
  const pane = paneOf(tab);
  return (tab === pane?.activeTab ? pane.editor?.snapshot(fileRef(tab)) : null) ?? tab.pending ?? null;
}

/** Saves a file tab's unsaved edits. Resolves false if they weren't saved. */
async function saveTab(tab) {
  const pane = paneOf(tab);
  if (tab === pane?.activeTab && pane.editor?.snapshot(fileRef(tab))) return pane.editor.save();
  if (!tab.pending) return true;
  if (!(await writeFile(tab, tab.pending))) return false;
  delete tab.pending;
  if (pane) {
    if (tab === pane.activeTab) setDirty(pane, false);
    renderTabs(pane);
  }
  reportDirty();
  return true;
}

/** Ctrl+S: saves the active tab (a new note asks where). */
function saveActiveTab() {
  const pane = activePane;
  const tab = pane.activeTab;
  if (tab?.draft) pane.editor?.save({ explicit: true });
  else if (tab && !tab.diff) saveTab(tab);
}

/** Drops a file tab's unsaved edits: it shows the file as on disk again. */
async function discardEdits(tab) {
  delete tab.pending;
  const pane = paneOf(tab);
  if (pane && tab === pane.activeTab) {
    if (pane.editor?.snapshot(fileRef(tab))) await pane.editor.load(null);
    setDirty(pane, false);
    renderTabs(pane);
  }
  reportDirty();
}

/** Leaving a file tab's file in the editor (another tab or mode): saves its edits, or keeps them in the tab. */
async function keepOrSave(pane, tab) {
  if (tab.diff || !tab.path) return true;
  if (autoSave) return pane.editor.save();
  const edits = pane.editor.snapshot(fileRef(tab));
  if (edits) {
    tab.pending = edits;
    // The tab has them now; the editor lets go of its copy, so another tab showing the same file doesn't pick them up.
    await pane.editor.load(null);
  }
  return true;
}

/**
 * Before a tab's unsaved edits would be lost or leave the window (closing it, another file in it, moving it to another
 * window): saves them, or when not saving automatically asks Save / Don't save / Cancel. Resolves false to stop.
 */
async function settleUnsaved(tab) {
  if (!unsavedEdits(tab)) return true;
  if (autoSave) return saveTab(tab);
  const pane = paneOf(tab);
  if (pane && tab !== pane.activeTab) await activateTab(tab); // show it while asking
  const answer = await callHost('askSave', { title: tab.title });
  if (answer === 'cancel') return false;
  if (answer === 'yes') return saveTab(tab);
  await discardEdits(tab);
  return true;
}

/** Turns "Save automatically" on or off; turning it on saves all unsaved edits (in editors and kept in tabs). */
async function setAutoSave(on) {
  autoSave = on;
  store.set('autoSave', on);
  if (on) for (const tab of allTabs().filter((t) => unsavedEdits(t))) await saveTab(tab);
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
  const dirty = panes.some((p) => p.el.classList.contains('dirty')
    || p.tabs.some((t) => t.pending || (t.draft && t !== p.activeTab && t.draftText?.trim())));
  if (dirty === reportedDirty) return;
  reportedDirty = dirty;
  post({ type: 'dirty', value: dirty });
}

async function openInNewTab(root, path, { background = false, pane = activePane } = {}) {
  const tab = createTab(root, path);
  if (!pane.activeTab) {
    pane.tabs.push(tab);
    await activateTab(tab);
  } else if (background) {
    insertTab(pane, tab, { background: true });
    renderTabs(pane);
  } else {
    insertTab(pane, tab);
    await activateTab(tab);
  }
  return tab;
}

/** The pane next to this one, made if there is only one. */
function ensureOtherPane(pane) {
  return otherPane(pane) ?? createPane(panes.indexOf(pane) + 1);
}

/** Opens a file in a pane: in a tab of its own there, or the tab that already shows it. */
async function openInPane(pane, root, path, hash = '') {
  const existing = pane.tabs.find((t) => t.root === root && t.path === path && !t.diff);
  if (existing) {
    await activateTab(existing);
    if (hash) scrollToHeading(pane, decodeURIComponent(hash.slice(1)));
    return;
  }
  const tab = await openInNewTab(root, path, { pane });
  if (hash && pane.activeTab === tab) scrollToHeading(pane, decodeURIComponent(hash.slice(1)));
}

/**
 * Moves a tab to another pane, at index in its tab bar (default: after the active tab). The pane it leaves closes if
 * that was its last tab.
 */
async function moveTab(tab, target, index) {
  const source = paneOf(tab);
  if (!source || source === target) return;
  if (tab === source.activeTab && !(await leaveTab(source))) return;
  const i = source.tabs.indexOf(tab);
  source.tabs.splice(i, 1);
  if (tab === source.activeTab) {
    source.activeTab = source.tabs[i] ?? source.tabs[i - 1] ?? null;
    if (source.activeTab || panes.length === 1) {
      renderTabs(source);
      await showTab(source);
    } else {
      removePane(source);
    }
  } else {
    renderTabs(source);
  }
  if (!panes.includes(target)) return;
  if (index == null) insertTab(target, tab);
  else target.tabs.splice(Math.min(index, target.tabs.length), 0, tab);
  await activateTab(tab);
}

const closedTabs = []; // for Ctrl+Shift+T: { root, path, index }

async function reopenClosedTab() {
  const closed = closedTabs.pop();
  if (!closed) return;
  const pane = activePane;
  const tab = createTab(closed.root, closed.path);
  pane.tabs.splice(Math.min(closed.index, pane.tabs.length), 0, tab);
  await activateTab(tab);
}

/** Ctrl+T: an empty tab for the current folder, with the note search focused. */
async function newEmptyTab(pane = activePane) {
  if (!currentRoot) return;
  const tab = createTab(currentRoot, null);
  insertTab(pane, tab);
  await activateTab(tab);
  if (document.body.classList.contains('side-hidden')) toggleSidebar();
  filter.focus();
}

/** Ctrl+1…8 jump to that tab, Ctrl+9 to the last one. */
function jumpToTab(n) {
  const tabs = activePane.tabs;
  const tab = n === 9 ? tabs.at(-1) : tabs[n - 1];
  if (tab) activateTab(tab);
}

/** remember: false when the tab moved to another window rather than being closed. */
async function closeTab(tab, { remember = true } = {}) {
  const pane = paneOf(tab);
  if (!pane) return;
  if (tab.draft) {
    if (!(await confirmCloseDraft(tab))) return;
  } else if (!(await settleUnsaved(tab))) {
    return;
  }
  const i = pane.tabs.indexOf(tab);
  if (i < 0) return;
  pane.tabs.splice(i, 1);
  if (remember && tab.path && !tab.diff) closedTabs.push({ root: tab.root, path: tab.path, index: i });
  if (tab !== pane.activeTab) {
    renderTabs(pane);
  } else {
    pane.activeTab = null;
    const next = pane.tabs[i] ?? pane.tabs[i - 1];
    if (next) {
      await activateTab(next);
    } else if (panes.length > 1) {
      // A pane's last tab closed: the other pane takes the whole width.
      removePane(pane);
    } else {
      renderTabs(pane);
      pane.el.classList.remove('diff');
      showEmpty(pane);
    }
  }
  reportDirty();
}

function cycleTab(step) {
  const tabs = activePane.tabs;
  const tab = activePane.activeTab;
  if (tabs.length < 2 || !tab) return;
  activateTab(tabs[(tabs.indexOf(tab) + step + tabs.length) % tabs.length]);
}

/**
 * Dragging a tab sideways reorders it. Dragging it elsewhere and letting go moves it: onto the other pane, onto the
 * right half of the only pane to make a second pane there, or out of the panes: onto another MRAkdown window if
 * dropped over one, otherwise into a new window (see dragOut).
 */
function startTabDrag(e, tab, el) {
  if (e.button !== 0 || e.target.closest('.tab-close')) return;
  activateTab(tab);
  const source = paneOf(tab);
  el.setPointerCapture(e.pointerId);
  const startX = e.clientX;
  const startY = e.clientY;
  let dragging = false;
  let drop = { kind: 'reorder' };

  const showDrop = () => {
    for (const p of panes) {
      p.el.classList.toggle('drop-pane', drop.kind === 'pane' && drop.pane === p);
      p.el.classList.toggle('drop-split', drop.kind === 'split' && p === source);
    }
  };

  const move = (ev) => {
    const dx = ev.clientX - startX;
    const dy = ev.clientY - startY;
    if (!dragging && Math.hypot(dx, dy) < 6) return;
    dragging = true;

    drop = tabDropTarget(source, ev.clientX, ev.clientY);
    showDrop();
    const detached = drop.kind !== 'reorder';
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
    source.tabs = [...source.tabsEl.children].map((c) => c._tab);
  };

  const end = (ev) => {
    el.removeEventListener('pointermove', move);
    el.classList.remove('detaching');
    el.style.transform = '';
    const target = drop;
    drop = { kind: 'reorder' };
    showDrop();
    if (!dragging || ev.type !== 'pointerup') return;
    if (target.kind === 'pane') moveTab(tab, target.pane, target.index);
    else if (target.kind === 'split') moveTab(tab, createPane(panes.indexOf(source) + 1));
    // A new note can't move to another window until it has been saved; a comparison can't move at all.
    else if (target.kind === 'window' && !tab.draft && !tab.diff) dragOut(tab, ev.screenX, ev.screenY);
  };
  el.addEventListener('pointermove', move);
  el.addEventListener('pointerup', end, { once: true });
  el.addEventListener('pointercancel', end, { once: true });
}

/**
 * Where a tab dragged from source would go if dropped at (x, y): { kind: 'reorder' } near its own tab bar,
 * { kind: 'pane', pane, index } over the other pane, { kind: 'split' } over the right half of the only pane
 * (when it has other tabs), or { kind: 'window' } anywhere else.
 */
function tabDropTarget(source, x, y) {
  for (const p of panes) {
    if (p === source) continue;
    const r = p.el.getBoundingClientRect();
    if (x >= r.left && x <= r.right && y >= r.top - 24 && y <= r.bottom) return { kind: 'pane', pane: p, index: tabIndexAt(p, x) };
  }
  const bar = source.tabbarEl.getBoundingClientRect();
  if (y >= bar.top - 24 && y <= bar.bottom + 40 && x >= 0 && x <= innerWidth) return { kind: 'reorder' };
  const r = source.el.getBoundingClientRect();
  const overSource = x >= r.left && x <= r.right && y >= r.top && y <= r.bottom;
  if (overSource && panes.length < MAX_PANES && source.tabs.length > 1 && x > r.left + r.width / 2) return { kind: 'split' };
  return { kind: 'window' };
}

const pendingDrags = new Map(); // drag id -> tab, until the host answers "dragOutResult"
let nextDragId = 1;

/**
 * Hands a dropped tab to the host. It moves the tab to the window under the pointer, or a new window;
 * the window's last tab only moves onto another window (which merges the two). The host then answers whether it moved.
 */
async function dragOut(tab, screenX, screenY) {
  if (!(await settleUnsaved(tab))) return;
  const pane = paneOf(tab);
  const id = nextDragId++;
  pendingDrags.set(id, tab);
  const scroll = tab === pane.activeTab ? pane.viewEl.scrollTop : tab.scroll;
  post({ type: 'dragOut', id, root: tab.root, path: tab.path, scroll, x: screenX, y: screenY, last: allTabs().length === 1 });
}

/** The pane at page x. */
function paneAt(x) {
  return panes.find((p) => {
    const r = p.el.getBoundingClientRect();
    return x >= r.left && x <= r.right;
  }) ?? activePane;
}

/** Index in a pane's tab bar for a tab dropped at page x. */
function tabIndexAt(pane, x) {
  const i = [...pane.tabsEl.children].findIndex((el) => {
    const r = el.getBoundingClientRect();
    return x < r.left + r.width / 2;
  });
  return i < 0 ? pane.tabs.length : i;
}

function goBack(pane = activePane) {
  const tab = pane.activeTab;
  const entry = tab?.back.pop();
  if (!entry) return;
  tab.forward.push({ path: tab.path, scroll: pane.viewEl.scrollTop });
  openNote(pane, entry.path, { history: 'none', scrollTo: entry.scroll });
}

function goForward(pane = activePane) {
  const tab = pane.activeTab;
  const entry = tab?.forward.pop();
  if (!entry) return;
  tab.back.push({ path: tab.path, scroll: pane.viewEl.scrollTop });
  openNote(pane, entry.path, { history: 'none', scrollTo: entry.scroll });
}

/* ---------- Notes ---------- */

/** Opens a note in a pane's active tab. history: 'push' records the previous note for Back. */
async function openNote(pane, path, { hash = '', history = 'push', keepScroll = false, scrollTo } = {}) {
  if (!pane.activeTab || pane.activeTab.draft || pane.activeTab.diff) {
    return openInNewTab(pane.activeTab?.root ?? currentRoot, path, { pane });
  }
  const tab = pane.activeTab;
  // Showing another file in this tab: its unsaved edits are saved first, or asked about (see "Saving"). The same file
  // again (a reload): saved first if saving automatically, else kept and shown.
  if (path !== tab.path) {
    if (!(await settleUnsaved(tab))) return;
  } else if (autoSave && pane.editor && !(await pane.editor.save())) {
    return;
  }

  const view = pane.viewEl;
  const previousScroll = view.scrollTop;
  const res = await fetch('/__api/note' + apiQuery(tab.root, path));
  if (tab !== pane.activeTab) return; // switched tabs while loading

  if (!res.ok) {
    tab.path = path;
    tab.title = noteTitle(path);
    pane.current = path;
    renderTabs(pane);
    pane.contentEl.innerHTML = `<div class="empty">File not found: ${esc(path)}</div>`;
    if (pane === activePane) { markActive(); updateTitle(); }
    if (pane.editor) await pane.editor.load(null);
    return;
  }

  let note = await res.json();
  // Unsaved edits kept in the tab: Read mode shows them rather than the file on disk.
  if (tab.pending && pane.mode === 'read') {
    const rendered = await fetch('/__api/render' + apiQuery(tab.root, note.path), { method: 'POST', body: tab.pending.text });
    if (tab !== pane.activeTab) return;
    if (rendered.ok) note = await rendered.json();
  }
  if (history === 'push' && tab.path && tab.path !== note.path) {
    tab.back.push({ path: tab.path, scroll: previousScroll });
    tab.forward = [];
  }
  tab.path = note.path;
  tab.title = note.title;
  pane.current = note.path;
  showNote(pane, note);
  renderTabs(pane);

  if (pane === activePane) {
    if (trees.has(tab.root) && expandAncestors(note.path) && !$('#filter').value) renderTree();
    else markActive();
  }

  if (keepScroll) view.scrollTop = previousScroll;
  else if (scrollTo != null) view.scrollTop = scrollTo;
  else if (hash) scrollToHeading(pane, decodeURIComponent(hash.slice(1)));
  else view.scrollTop = 0;

  if (pane.editor && pane.mode !== 'read') {
    // The editor takes over any unsaved edits the tab kept; edits it already has for this file stay as they are.
    const file = { root: tab.root, path: note.path };
    if (!pane.editor.snapshot(file)) await pane.editor.load(file, tab.pending ?? null);
    delete tab.pending;
    pane.editor.renderPreview();
  } else {
    setDirty(pane, Boolean(tab.pending));
  }

  // Rendered before the folder scan finished: re-render once it has, so links to other folders resolve.
  if (!note.indexed) {
    (treeRequests.get(tab.root) ?? loadTree(tab.root)).then(() => {
      if (pane.activeTab === tab && pane.current === note.path) openNote(pane, note.path, { history: 'none', keepScroll: true });
    });
  }
  return note;
}

function showEmpty(pane) {
  pane.current = null;
  pane.el.classList.remove('plain-file');
  pane.contentEl.classList.remove('viewer-wide', 'diff-wide');
  pane.contentEl.innerHTML = '<div class="empty">Select a file</div>';
  if (pane === activePane) { markActive(); updateTitle(); }
  pane.editor?.load(null);
}

/**
 * Renders a note ({ title, html }) into a pane's reading/preview area, or any other file as plain text
 * ({ markdown: false, text } — or binary / tooLarge when it can't be shown).
 */
function showNote(pane, note) {
  const content = pane.contentEl;
  // Markdown-only tools (formatting toolbar, shortcuts, image paste) are hidden for other files.
  pane.el.classList.toggle('plain-file', note.markdown === false);
  content.classList.remove('viewer-wide', 'diff-wide');
  delete content.dataset.viewKind; // set again by the viewer for files it shows (see renderViewer)
  if (note.markdown === false && !note.binary && !note.tooLarge) {
    showInViewer(content, note);
  } else if (note.markdown === false) {
    content.innerHTML = textFileHtml(note);
    highlightCode(content);
  } else {
    content.innerHTML = `<div class="inline-title">${esc(note.title)}</div>${note.html}`;
    enhance(content);
  }
  if (pane === activePane) updateTitle();
}

// Non-Markdown text files are shown by viewers.js (loaded on first use), which picks or lets the user
// choose how to show them: text, code, JSON, CSV or XML.
let viewers = null;

function showInViewer(content, note) {
  const host = { store, highlightCode, kindByExt: VIEWER_KIND_BY_EXT };
  if (viewers) {
    viewers.renderViewer(content, note, host);
    return;
  }
  content.innerHTML = textFileHtml(note); // plain text until the viewer module has loaded
  import('/__app/viewers.js').then((module) => {
    viewers = module;
    // Still showing the same file? Then switch to its viewer.
    if (content.querySelector('.inline-title')?.textContent !== note.title) return;
    viewers.renderViewer(content, note, host);
    // Now that the file's type is known, a pane in Live mode can switch to the editor for it.
    const pane = panes.find((p) => p.contentEl === content);
    if (pane?.editor && pane.mode === 'live') pane.editor.useSurface();
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

async function setViewMode(pane, mode) {
  if (mode === pane.mode || pane.activeTab?.diff) return;
  if (mode !== 'read' && !pane.editor) {
    const { createEditor } = await import('/__app/editor.js');
    pane.editor = createEditor({
      view: pane.viewEl,
      showNote: (note) => showNote(pane, note),
      setDirty: (dirty) => setDirty(pane, dirty),
      getMode: () => pane.mode,
      isPlain: () => pane.el.classList.contains('plain-file'),
      viewKind: () => pane.contentEl.dataset.viewKind ?? null,
      saveDraft: (text) => saveDraftAs(pane, text),
      write: writeFile,
      shortcut: (e) => actionFor(e, 'editor')?.id ?? null,
      hint: shortcutHint,
      // A link clicked in Live mode, with the same modifier keys as in the reading view.
      openLink: (href, e) => openHref(href, e, e.button === 1),
      calloutColor: (type) => CALLOUT_COLORS[type] ?? CALLOUT_COLORS.note,
    });
  }
  const editor = pane.editor;
  const tab = pane.activeTab;

  // Between Edit, Split and Live the editor keeps the text (and any unsaved edits); only the view changes.
  if (pane.mode !== 'read' && mode !== 'read') {
    pane.mode = mode;
    pane.el.dataset.mode = mode;
    for (const btn of pane.el.querySelectorAll('.toolbar button[data-mode]')) {
      btn.classList.toggle('active', btn.dataset.mode === mode);
    }
    await editor.useSurface();
    editor.renderPreview();
    editor.focus();
    return;
  }

  const leavingEdit = pane.mode !== 'read' && mode === 'read';
  if (leavingEdit && tab?.draft) tab.draftText = editor.text();
  else if (leavingEdit && tab && !(await keepOrSave(pane, tab))) return;

  pane.mode = mode;
  pane.el.dataset.mode = mode;
  for (const btn of pane.el.querySelectorAll('.toolbar button[data-mode]')) {
    btn.classList.toggle('active', btn.dataset.mode === mode);
  }

  if (mode === 'read') {
    // Show the saved file as rendered by the normal note view (or a new note's text as a preview).
    if (tab?.draft) renderDraft(pane, tab);
    else if (pane.current) openNote(pane, pane.current, { history: 'none', keepScroll: true });
  } else {
    await editor.load(tab?.draft ? draftRef(tab) : pane.current && tab ? { root: tab.root, path: pane.current } : null,
      tab?.draft ? null : tab?.pending ?? null);
    if (tab) delete tab.pending;
    editor.renderPreview();
    editor.focus();
  }
}

function setDirty(pane, dirty) {
  if (pane.el.classList.contains('dirty') === dirty) return;
  pane.el.classList.toggle('dirty', dirty);
  renderTabs(pane);
  if (pane === activePane) updateTitle();
  reportDirty();
}

function scrollToHeading(pane, text) {
  const wanted = text.trim().toLowerCase();
  const target = pane.contentEl.querySelector(`[id="${CSS.escape(text)}"]`)
    ?? [...pane.contentEl.querySelectorAll('h1, h2, h3, h4, h5, h6')]
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
  const m = isAppUrl(url) && url.pathname.match(/^\/f\/([^/]+)\/(.+)$/);
  if (!m) return null;
  const path = decodeURIComponent(m[2]);
  return /\.(md|markdown)$/i.test(path) ? { root: m[1], path, hash: url.hash } : null;
}

/** Link clicks in a note, with the same modifier keys as a browser (see clickTarget). */
function onContentLink(pane, e, middle) {
  const a = e.target.closest('a');
  if (!a) return;
  e.preventDefault();
  const href = a.getAttribute('href');
  if (!href || a.classList.contains('unresolved')) return;
  if (href.startsWith('#')) {
    scrollToHeading(pane, decodeURIComponent(href.slice(1)));
    return;
  }

  openHref(href, e, middle);
}

/** Opens a link's address: a note (in a tab, as clickTarget says), another file in its app, or a web page. */
function openHref(href, e, middle) {
  const a = document.createElement('a');
  a.setAttribute('href', href);
  const note = noteLink(a);
  if (note) {
    openIn(note.root, note.path, clickTarget(e, middle), note.hash);
    return;
  }
  const url = new URL(href, location.href);
  const file = isAppUrl(url) && url.pathname.match(/^\/f\/([^/]+)\/(.+)$/);
  if (file) post({ type: 'openFile', root: file[1], path: decodeURIComponent(file[2]) });
  else if (!isAppUrl(url)) post({ type: 'open', url: url.href });
}

/* ---------- Comparing files ---------- */

// A comparison is a tab of its own: { diff: { left, right } }, each side { root, path, version } with version
// 'file' (the file now), 'head' (as in git's last commit) or 'commit' (as in a given commit: the side also has
// { commit, commitPath, short }, commitPath being its path in the repository then). diff.js shows the two side by side.
let compareSelection = null; // { root, path } picked with "Select for compare"
let diffModule = null;

const fileName = (path) => path.slice(path.lastIndexOf('/') + 1);

/**
 * Menu items for comparing a file: with the one selected for compare, an open file (otherTab, described as
 * otherWhere, e.g. "other pane"), the last commit or an earlier one.
 */
function compareItems(root, path, otherTab, otherWhere) {
  const items = [];
  const same = (a) => a && a.root === root && a.path === path;
  if (compareSelection && !same(compareSelection)) {
    const selected = compareSelection;
    items.push({
      label: `Compare with “${fileName(selected.path)}”`,
      action: () => openDiff({ ...selected, version: 'file' }, { root, path, version: 'file' }),
    });
  }
  if (otherTab?.path && !otherTab.draft && !otherTab.diff && !same(otherTab) && !same(compareSelection)) {
    items.push({
      label: `Compare with “${fileName(otherTab.path)}” (${otherWhere})`,
      action: () => openDiff({ root: otherTab.root, path: otherTab.path, version: 'file' }, { root, path, version: 'file' }),
    });
  }
  items.push({ label: 'Select for compare', action: () => { compareSelection = { root, path }; } });
  items.push({
    label: 'Compare with last commit',
    action: () => openDiff({ root, path, version: 'head' }, { root, path, version: 'file' }),
  });
  items.push({ label: 'Compare with commit…', action: () => pickCommit(root, path) });
  return items;
}

/** Lists the commits that changed a file (from git), to compare the file with one of them. */
async function pickCommit(root, path) {
  const { x, y } = lastMenuPoint;
  showContextMenu(x, y, [{ label: 'Loading commits…', disabled: true }]);
  const loading = contextMenu;
  // Closed (clicked elsewhere) while loading: don't pop the list up after all.
  const show = (items) => { if (contextMenu === loading) showContextMenu(x, y, items); };
  let commits;
  try {
    const res = await fetch('/__api/git-log' + apiQuery(root, path));
    if (!res.ok) {
      show([{ label: (await res.text()) || 'Git couldn\'t list the commits.', disabled: true }]);
      return;
    }
    commits = await res.json();
  } catch (e) {
    show([{ label: String(e), disabled: true }]);
    return;
  }
  if (!commits.length) {
    show([{ label: 'No commits with this file yet.', disabled: true }]);
    return;
  }
  show(commits.map((c) => ({
    label: `${c.short}  ${c.subject}`,
    hint: c.date,
    // The file may have had another name then (git follows renames).
    title: `${c.subject}\n${c.author}, ${c.date}` + (fileName(c.path) !== fileName(path) ? `\nThen named ${c.path}` : ''),
    action: () => openDiff(
      { root, path, version: 'commit', commit: c.hash, commitPath: c.path, short: c.short },
      { root, path, version: 'file' }),
  })));
  contextMenu?.classList.add('commit-menu');
}

/** Opens a comparison tab in the active pane. */
async function openDiff(left, right) {
  const tab = createTab(right.root, null);
  tab.diff = { left, right };
  tab.title = diffTitle(tab.diff);
  insertTab(activePane, tab);
  await activateTab(tab);
}

/** Which version a side is, in a word or two: "now", "last commit", or the commit's short hash. */
const versionName = (side) => (side.version === 'head' ? 'last commit' : side.version === 'commit' ? side.short : 'now');

function diffTitle({ left, right }) {
  if (left.root === right.root && left.path === right.path) return `${fileName(right.path)} (${versionName(left)} ↔ ${versionName(right)})`;
  return `${fileName(left.path)} ↔ ${fileName(right.path)}`;
}

/** A side of a comparison, for people: its folder and path, and which commit for git's versions. */
function sideLabel(side) {
  const where = [rootNames.get(side.root), side.path].filter(Boolean).join(' / ');
  if (side.version === 'head') return `${where} (last commit)`;
  if (side.version === 'commit') return `${where} (commit ${side.short})`;
  return where;
}
const diffDescription = (diff) => `${sideLabel(diff.left)}  ↔  ${sideLabel(diff.right)}`;

/** A side's text: { text }, or { error } with a message to show instead. */
async function loadSide(side) {
  const api = side.version === 'file' ? '/__api/source' : '/__api/git';
  const commit = side.version === 'commit'
    ? `&commit=${encodeURIComponent(side.commit)}&path=${encodeURIComponent(side.commitPath)}`
    : '';
  try {
    const res = await fetch(api + apiQuery(side.root, side.path) + commit);
    return res.ok ? { text: await res.text() } : { error: (await res.text()) || `Couldn't read ${side.path}` };
  } catch (e) {
    return { error: String(e) };
  }
}

async function showDiff(pane, tab, { keepScroll = false } = {}) {
  pane.current = null;
  pane.el.classList.remove('plain-file');
  pane.contentEl.classList.remove('viewer-wide');
  if (pane === activePane) { markActive(); updateTitle(); }
  pane.editor?.load(null);
  const scroll = keepScroll ? pane.viewEl.scrollTop : 0;
  diffModule ??= await import('/__app/diff.js');
  if (pane.activeTab !== tab) return;
  await diffModule.renderDiff(pane.contentEl, tab.diff, {
    store,
    load: loadSide,
    label: sideLabel,
    swap: () => {
      tab.diff = { left: tab.diff.right, right: tab.diff.left };
      tab.title = diffTitle(tab.diff);
      renderTabs(pane);
      updateTitle();
      showDiff(pane, tab);
    },
    isCurrent: () => pane.activeTab === tab,
    hint: shortcutHint,
  });
  pane.viewEl.scrollTop = scroll;
}

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
$('#new-note').onclick = () => newNote();

async function openFolderTab(root) {
  const tree = trees.get(root) ?? await loadTree(root);
  await openInNewTab(root, homeNote(tree)?.path ?? null);
}

/** F5 / Ctrl+R: a browser would reload the page and lose every tab, so reload the folder and file instead. */
async function reloadCurrent() {
  if (!currentRoot) return;
  await loadTree(currentRoot);
  const pane = activePane;
  if (pane.activeTab?.diff) showDiff(pane, pane.activeTab, { keepScroll: true });
  else if (!pane.current) return;
  else if (pane.editor && pane.mode !== 'read') pane.editor.refresh();
  else openNote(pane, pane.current, { history: 'none', keepScroll: true });
}

/* ---------- Keyboard shortcuts ---------- */

// Every shortcut is an action with default keys, following common browser conventions where one exists; the keys can
// be changed in Settings (shortcuts.js). Keys are written like "Ctrl+Shift+E": Ctrl, Alt and Shift in that order, then
// the key (a letter in capitals, or a key name such as "Tab", "PageDown", "F5" or "ArrowLeft"). Editor actions only
// apply while editing a Markdown file (see format.js). Ctrl+1…8 and Ctrl+9 (go to that tab, the last tab) are fixed.
const ACTIONS = [
  { id: 'newFile', group: 'Files', label: 'New file', keys: ['Ctrl+N'], run: () => newNote() },
  { id: 'openFile', group: 'Files', label: 'Open file', keys: ['Ctrl+O'], run: () => openFile() },
  { id: 'openFolder', group: 'Files', label: 'Open folder', keys: ['Ctrl+Shift+O'], run: () => openFolder() },
  { id: 'save', group: 'Files', label: 'Save', keys: ['Ctrl+S'], run: () => saveActiveTab() },
  { id: 'reload', group: 'Files', label: 'Reload the file and folder', keys: ['F5', 'Ctrl+R'], run: () => reloadCurrent() },
  { id: 'search', group: 'Files', label: 'Search files', keys: ['Ctrl+P'], run: () => { filter.focus(); filter.select(); } },
  { id: 'newTab', group: 'Tabs and windows', label: 'New tab', keys: ['Ctrl+T'], run: () => newEmptyTab() },
  {
    id: 'closeTab', group: 'Tabs and windows', label: 'Close tab', keys: ['Ctrl+W'],
    run: () => { if (activePane.activeTab) closeTab(activePane.activeTab); },
  },
  { id: 'reopenTab', group: 'Tabs and windows', label: 'Reopen closed tab', keys: ['Ctrl+Shift+T'], run: () => reopenClosedTab() },
  { id: 'nextTab', group: 'Tabs and windows', label: 'Next tab', keys: ['Ctrl+Tab', 'Ctrl+PageDown'], run: () => cycleTab(1) },
  { id: 'previousTab', group: 'Tabs and windows', label: 'Previous tab', keys: ['Ctrl+Shift+Tab', 'Ctrl+PageUp'], run: () => cycleTab(-1) },
  { id: 'back', group: 'Tabs and windows', label: 'Back', keys: ['Alt+ArrowLeft'], run: () => goBack() },
  { id: 'forward', group: 'Tabs and windows', label: 'Forward', keys: ['Alt+ArrowRight'], run: () => goForward() },
  {
    id: 'newWindow', group: 'Tabs and windows', label: 'New window', keys: ['Ctrl+Shift+N'],
    run: () => { if (currentRoot) post({ type: 'openWindow', root: currentRoot, path: null }); },
  },
  { id: 'closeWindow', group: 'Tabs and windows', label: 'Close window', keys: ['Ctrl+Shift+W'], run: () => post({ type: 'closeWindow' }) },
  {
    // Edit is the 'live' mode (edit it as it looks), Source the 'edit' mode (the plain text); see app.html
    // Each switches to its mode, or back to Read when that mode is already on
    id: 'toggleLive', group: 'View', label: 'Edit mode on or off', keys: ['Ctrl+E'],
    run: () => setViewMode(activePane, activePane.mode === 'live' ? 'read' : 'live'),
  },
  {
    id: 'toggleEdit', group: 'View', label: 'Source mode (the plain text) on or off', keys: ['Ctrl+U'],
    run: () => setViewMode(activePane, activePane.mode === 'edit' ? 'read' : 'edit'),
  },
  {
    id: 'toggleSplit', group: 'View', label: 'Split mode (source and preview) on or off', keys: ['Ctrl+Shift+E'],
    run: () => setViewMode(activePane, activePane.mode === 'split' ? 'read' : 'split'),
  },
  { id: 'toggleSidebar', group: 'View', label: 'Show or hide the folder panel', keys: ['Ctrl+\\'], run: () => toggleSidebar() },
  {
    id: 'nextChange', group: 'View', label: 'Next change, in a comparison', keys: ['F7'],
    when: () => activePane.activeTab?.diff && diffModule, run: () => diffModule.goToChange(activePane.contentEl, 1),
  },
  {
    id: 'previousChange', group: 'View', label: 'Previous change, in a comparison', keys: ['Shift+F7'],
    when: () => activePane.activeTab?.diff && diffModule, run: () => diffModule.goToChange(activePane.contentEl, -1),
  },
  { id: 'bold', group: 'Editing Markdown', label: 'Bold', keys: ['Ctrl+B'], scope: 'editor' },
  { id: 'italic', group: 'Editing Markdown', label: 'Italic', keys: ['Ctrl+I'], scope: 'editor' },
  { id: 'link', group: 'Editing Markdown', label: 'Link', keys: ['Ctrl+K'], scope: 'editor' },
];

/** Each action's keys: the defaults, except where changed in Settings (stored as { action id: keys }). */
function loadShortcuts() {
  const changed = store.get('shortcuts', {});
  return Object.fromEntries(ACTIONS.map((a) => [a.id, Array.isArray(changed[a.id]) ? changed[a.id] : a.keys]));
}
let shortcuts = loadShortcuts();

/** Uses and remembers new keys ({ action id: keys }); only those that differ from the defaults are stored. */
function setShortcuts(next) {
  shortcuts = next;
  store.set('shortcuts', Object.fromEntries(ACTIONS
    .filter((a) => next[a.id].join() !== a.keys.join())
    .map((a) => [a.id, next[a.id]])));
  applyShortcutHints();
}

/**
 * A key press written as shortcut keys ("Ctrl+Shift+E"), or null for a modifier key on its own. AltGr (which Windows
 * reports as Ctrl+Alt) doesn't count as a modifier, so typing characters with it never triggers a shortcut.
 */
function keysOf(e) {
  if (['Control', 'Shift', 'Alt', 'Meta', 'AltGraph', 'CapsLock', 'Dead', 'Unidentified'].includes(e.key)) return null;
  const altGraph = e.getModifierState?.('AltGraph');
  const parts = [];
  if ((e.ctrlKey || e.metaKey) && !altGraph) parts.push('Ctrl');
  if (e.altKey && !altGraph) parts.push('Alt');
  if (e.shiftKey) parts.push('Shift');
  parts.push(e.key === ' ' ? 'Space' : e.key.length === 1 ? e.key.toUpperCase() : e.key);
  return parts.join('+');
}

/** The action a key press runs in a scope ('window' or 'editor'), if any. */
function actionFor(e, scope) {
  const keys = keysOf(e);
  return keys ? ACTIONS.find((a) => (a.scope ?? 'window') === scope && shortcuts[a.id].includes(keys)) ?? null : null;
}

/** Keys as people read them: "Alt+←", "Page Down". */
const describeKeys = (keys) => keys
  .replace('ArrowLeft', '←').replace('ArrowRight', '→').replace('ArrowUp', '↑').replace('ArrowDown', '↓')
  .replace('PageDown', 'Page Down').replace('PageUp', 'Page Up');

/** An action's first keys for tooltips and menus ("Ctrl+W"), or '' if it has none. */
const shortcutHint = (id) => (shortcuts[id]?.[0] ? describeKeys(shortcuts[id][0]) : '');

/**
 * Tooltips and placeholders that mention a shortcut: elements with data-shortcut (an action id) and data-hint, a text
 * with {keys} where the keys go ("New file ({keys})"); without keys the bracketed part is left out.
 */
function applyShortcutHints(root = document) {
  for (const el of root.querySelectorAll('[data-shortcut]')) {
    const keys = shortcutHint(el.dataset.shortcut);
    const text = keys ? el.dataset.hint.replace('{keys}', keys) : el.dataset.hint.replace(/\s*\([^)]*\{keys\}[^)]*\)/, '');
    if (el.tagName === 'INPUT') el.placeholder = text;
    else el.title = text;
  }
}

addEventListener('keydown', (e) => {
  if (e.defaultPrevented) return;
  // Ctrl+1…8 go to that tab, Ctrl+9 to the last one.
  if (e.ctrlKey && !e.altKey && /^[1-9]$/.test(e.key) && !e.getModifierState?.('AltGraph')) {
    e.preventDefault();
    jumpToTab(Number(e.key));
    return;
  }
  const action = actionFor(e, 'window');
  if (!action || (action.when && !action.when())) return;
  e.preventDefault();
  action.run();
});

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

let settingsPanel = null;

function closeSettingsPanel() {
  settingsPanel?.remove();
  settingsPanel = null;
}

/** The Settings panel: accent colour, saving, keyboard shortcuts. */
function toggleSettingsPanel() {
  if (settingsPanel) { closeSettingsPanel(); return; }

  const saved = store.get('accent', null);
  const panel = document.createElement('div');
  panel.id = 'settings';
  panel.setAttribute('role', 'dialog');
  panel.setAttribute('aria-label', 'Settings');
  panel.innerHTML = `
    <div class="settings-title">Accent colour</div>
    <div class="swatches">
      ${ACCENTS.map((a, i) => `<button class="swatch" data-i="${i}" title="${a.name}" aria-label="${a.name}"
        style="--c-light:${a.light};--c-dark:${a.dark}"></button>`).join('')}
      <label class="swatch custom" title="Custom colour"><input type="color" aria-label="Custom colour"></label>
    </div>
    <button class="settings-reset">Reset to default</button>
    <div class="settings-title settings-section">Saving</div>
    <div class="settings-row">
      <label class="settings-check"><input type="checkbox" class="auto-save"> Save automatically</label>
      <button class="settings-help" aria-label="About saving" aria-describedby="auto-save-help">?</button>
      <div class="settings-help-text" id="auto-save-help" role="tooltip">On: edits are saved whenever you switch to
        another file, tab or mode. Off: a tab keeps its unsaved edits until you save them${shortcutHint('save') ? ` (${shortcutHint('save')})` : ''},
        and you're asked before they'd be lost.</div>
    </div>
    <div class="settings-title settings-section">Keyboard shortcuts</div>
    <button class="settings-button change-shortcuts">Change shortcuts…</button>`;

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
  const autoSaveBox = panel.querySelector('.auto-save');
  autoSaveBox.checked = autoSave;
  autoSaveBox.onchange = () => setAutoSave(autoSaveBox.checked);
  panel.querySelector('.change-shortcuts').onclick = async () => {
    closeSettingsPanel();
    const { openShortcutsDialog } = await import('/__app/shortcuts.js');
    openShortcutsDialog({ actions: ACTIONS, shortcuts, keysOf, describeKeys, setShortcuts });
  };

  $('#main').append(panel);
  settingsPanel = panel;
}

settingsButton.onclick = toggleSettingsPanel;
addEventListener('pointerdown', (e) => {
  if (settingsPanel && !settingsPanel.contains(e.target) && !settingsButton.contains(e.target)) closeSettingsPanel();
});
addEventListener('keydown', (e) => {
  if (e.key === 'Escape') closeSettingsPanel();
});

function setFormatToolbar(visible) {
  document.body.classList.toggle('hide-format', !visible);
  for (const btn of document.querySelectorAll('.format-toggle')) btn.setAttribute('aria-pressed', String(visible));
  store.set('formatHidden', !visible);
}

function toggleSidebar() {
  store.set('sidebarHidden', document.body.classList.toggle('side-hidden'));
}
for (const btn of document.querySelectorAll('.toggle-side')) btn.onclick = toggleSidebar;

/* ---------- Window title bar (Linux and Windows) ---------- */

// The host shows no title bar. It sets hostWindowControls ({ left, right }: lists of 'minimize', 'maximize' and
// 'close'; on Linux from the desktop's button layout), and the top of the page does a title bar's job instead.
// On Windows (nativeDrag) the empty parts of the bar are CSS drag regions that WebView2 handles like a real title
// bar; on Linux the page reports drags and clicks to the host below.
if (window.hostWindowControls) {
  const svg = (paths) => `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${paths}</svg>`;
  const ICONS = {
    minimize: svg('<path d="M6 12h12"/>'),
    // Both icons; CSS shows "restore" while the window is maximized (see the windowState message).
    maximize: `<span class="icon-maximize">${svg('<rect x="6" y="6" width="12" height="12" rx="1.5"/>')}</span>`
      + `<span class="icon-restore">${svg('<rect x="5" y="8" width="11" height="11" rx="1.5"/><path d="M8 8V6.5A1.5 1.5 0 0 1 9.5 5h8A1.5 1.5 0 0 1 19 6.5v8a1.5 1.5 0 0 1-1.5 1.5H16"/>')}</span>`,
    close: svg('<path d="M17 7 7 17"/><path d="m7 7 10 10"/>'),
  };
  const TITLES = { minimize: 'Minimize', maximize: 'Maximize', close: 'Close' };
  const controls = (buttons, side) => {
    const group = document.createElement('div');
    group.className = `window-controls ${side}`;
    for (const name of buttons) {
      const btn = document.createElement('button');
      btn.className = `window-${name}`;
      btn.title = TITLES[name];
      btn.setAttribute('aria-label', TITLES[name]);
      btn.innerHTML = ICONS[name];
      btn.onclick = () => post({ type: name === 'close' ? 'closeWindow' : name });
      group.append(btn);
    }
    return group;
  };
  if (window.hostWindowControls.nativeDrag) document.body.classList.add('native-titlebar');
  const { left, right } = window.hostWindowControls;
  // Buttons on the left sit in the folder panel's header, or in the first tab bar while the panel is hidden;
  // buttons on the right at the end of the last tab bar (see layoutPanes).
  if (left.length) {
    $('.side-head').prepend(controls(left, 'left'));
    windowButtons.left = controls(left, 'left');
  }
  if (right.length) windowButtons.right = controls(right, 'right');

  // The empty parts of the top bar: dragging them moves the window, and double, middle and right clicks do what
  // the desktop does for title bars. (Not needed with native drag regions.)
  const isEmptyBar = (el) => el.matches('.tabbar, .tabs, .side-head, #root-name, .window-controls');
  for (const bar of window.hostWindowControls.nativeDrag ? [] : [$('#panes'), $('.side-head')]) {
    bar.addEventListener('pointerdown', (e) => {
      if (e.button !== 0 || !isEmptyBar(e.target)) return;
      const startX = e.clientX;
      const startY = e.clientY;
      const move = (ev) => {
        if (!(ev.buttons & 1)) return stop();
        if (Math.hypot(ev.clientX - startX, ev.clientY - startY) < 4) return;
        stop();
        post({ type: 'windowDrag', x: ev.clientX, y: ev.clientY });
      };
      const stop = () => {
        removeEventListener('pointermove', move);
        removeEventListener('pointerup', stop);
      };
      addEventListener('pointermove', move);
      addEventListener('pointerup', stop);
    });
    bar.addEventListener('dblclick', (e) => {
      if (isEmptyBar(e.target)) post({ type: 'titlebarGesture', gesture: 'double-click' });
    });
    bar.addEventListener('auxclick', (e) => {
      if (e.button === 1 && isEmptyBar(e.target)) post({ type: 'titlebarGesture', gesture: 'middle-click' });
    });
    bar.addEventListener('contextmenu', (e) => {
      if (!isEmptyBar(e.target)) return;
      e.preventDefault();
      post({ type: 'titlebarGesture', gesture: 'right-click' });
    });
  }
}

/* ---------- Messages from the host ---------- */

hostBridge.addEventListener('message', async (e) => {
  const msg = e.data;
  switch (msg?.type) {
    case 'windowState':
      // The maximize button shows "restore" while the window is maximized.
      document.body.classList.toggle('window-maximized', msg.maximized);
      document.querySelectorAll('.window-maximize').forEach((b) => {
        b.title = msg.maximized ? 'Restore' : 'Maximize';
        b.setAttribute('aria-label', b.title);
      });
      break;
    case 'saveAndClose': {
      // The window is closing with unsaved edits; the host closes once we confirm.
      // New notes with text ask Save / Don't save / Cancel first; Cancel keeps the window open.
      for (const tab of allTabs().filter((t) => t.draft)) {
        if (!(await confirmCloseDraft(tab))) {
          post({ type: 'closeCancelled' });
          return;
        }
      }
      for (const tab of allTabs().filter((t) => !t.draft && !t.diff)) {
        if (!(await settleUnsaved(tab))) {
          post({ type: 'closeCancelled' });
          return;
        }
      }
      post({ type: 'closeReady' });
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
      const existing = msg.path && allTabs().find((t) => t.root === msg.root && t.path === msg.path && !t.diff);
      if (existing) {
        activateTab(existing);
      } else if (msg.x != null) {
        const pane = paneAt(msg.x);
        const tab = createTab(msg.root, msg.path);
        tab.scroll = msg.scroll ?? 0;
        pane.tabs.splice(tabIndexAt(pane, msg.x), 0, tab);
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

/** Files in a root folder changed on disk: refresh its tree, and the files shown from that folder. */
async function onRootChanged(root) {
  if (trees.has(root)) await loadTree(root);
  for (const pane of panes) {
    const tab = pane.activeTab;
    if (tab?.diff) {
      if (tab.diff.left.root === root || tab.diff.right.root === root) showDiff(pane, tab, { keepScroll: true });
    } else if (tab?.root === root && pane.current) {
      // While editing, refresh the editor instead of re-opening the note, so the caret stays put.
      if (pane.editor && pane.mode !== 'read') pane.editor.refresh();
      else openNote(pane, pane.current, { history: 'none', keepScroll: true });
    }
  }
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
  applyShortcutHints();

  try {
    const params = new URLSearchParams(location.search);
    const root = params.get('r');
    const start = params.get('n');
    currentRoot = root;
    // One pane to start with, in read mode so opening a file never waits for the editor.
    const pane = createPane();
    activePane = pane;

    // Show the requested note first; the folder tree loads alongside it.
    const treeLoaded = loadTree(root);
    const path = start ?? homeNote(await treeLoaded)?.path ?? null;
    const tab = createTab(root, path);
    pane.tabs.push(tab);
    pane.activeTab = tab;
    renderTabs(pane);
    if (path) await openNote(pane, path, { hash: start ? location.hash : '', history: 'none' });
    else showEmpty(pane);
  } finally {
    // Lets the host send files that were opened while this window was starting.
    post({ type: 'ready' });
  }
})();
