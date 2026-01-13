import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import './App.css';

/**
 * Storage schema:
 * localStorage[STORAGE_KEY] = {
 *   version: 1,
 *   notes: Note[],
 *   trash: Note[],
 *   ui: { theme: 'light'|'dark' }
 * }
 */

const STORAGE_KEY = 'notesAppData';
const STORAGE_VERSION = 1;

const NOTE_SORTS = [
  { value: 'lastModifiedDesc', label: 'Last Modified' },
  { value: 'createdDesc', label: 'Created Date' },
  { value: 'titleAsc', label: 'Title A–Z' },
  { value: 'titleDesc', label: 'Title Z–A' },
];

function nowTs() {
  return Date.now();
}

function safeJsonParse(value, fallback) {
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function generateId() {
  // Timestamp-based ID is fine for local apps; include randomness for extra safety.
  return `${Date.now()}_${Math.random().toString(16).slice(2)}`;
}

function normalizeText(s) {
  return (s || '').toLowerCase();
}

function countBytesApprox(str) {
  // Approximate UTF-8 bytes by using Blob size; safe for browsers.
  try {
    return new Blob([str]).size;
  } catch {
    return (str || '').length;
  }
}

function formatRelativeTime(timestamp) {
  const ts = typeof timestamp === 'number' ? timestamp : 0;
  const diffMs = Date.now() - ts;
  const diffSec = Math.floor(diffMs / 1000);
  if (diffSec < 10) return 'Just now';
  if (diffSec < 60) return `${diffSec} seconds ago`;
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return `${diffMin} minute${diffMin === 1 ? '' : 's'} ago`;
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return `${diffHr} hour${diffHr === 1 ? '' : 's'} ago`;
  const diffDay = Math.floor(diffHr / 24);
  if (diffDay === 1) return 'Yesterday';
  if (diffDay < 7) return `${diffDay} days ago`;
  const d = new Date(ts);
  return d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

function tagColorFromName(tag) {
  // Deterministic hue from string hash.
  let hash = 0;
  for (let i = 0; i < tag.length; i += 1) {
    // eslint-disable-next-line no-bitwise
    hash = (hash * 31 + tag.charCodeAt(i)) | 0;
  }
  // eslint-disable-next-line no-bitwise
  const hue = Math.abs(hash) % 360;
  return `hsl(${hue} 70% 45%)`;
}

function escapeHtml(text) {
  return (text || '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function renderMarkdownToHtml(md) {
  // Lightweight renderer (no external libs). Supports: headings, bold, italic, underline, strikethrough, inline code,
  // code blocks, blockquotes, lists, paragraphs, links.
  // NOTE: We escape HTML first to prevent injection; then apply markdown transformations.
  const raw = escapeHtml(md || '');
  const lines = raw.split('\n');

  const out = [];
  let inCodeBlock = false;
  let codeLang = '';
  let codeLines = [];

  const flushCodeBlock = () => {
    if (!inCodeBlock) return;
    const code = codeLines.join('\n');
    out.push(
      `<pre class="md-code"><code class="md-code-inner" data-lang="${escapeHtml(codeLang)}">${code}</code></pre>`,
    );
    inCodeBlock = false;
    codeLang = '';
    codeLines = [];
  };

  const parseInline = (text) => {
    // Order matters; we keep it conservative.
    let t = text;

    // inline code
    t = t.replace(/`([^`]+)`/g, '<code class="md-inline-code">$1</code>');
    // bold
    t = t.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
    // italic
    t = t.replace(/\*([^*]+)\*/g, '<em>$1</em>');
    // underline (non-standard, use __text__)
    t = t.replace(/__([^_]+)__/g, '<u>$1</u>');
    // strikethrough
    t = t.replace(/~~([^~]+)~~/g, '<s>$1</s>');
    // links [text](url)
    t = t.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank" rel="noreferrer">$1</a>');
    return t;
  };

  const isUl = (line) => /^(\s*)[-*]\s+/.test(line);
  const isOl = (line) => /^(\s*)\d+\.\s+/.test(line);

  let i = 0;
  while (i < lines.length) {
    const line = lines[i];

    // fenced code
    const fence = line.match(/^```(\w+)?\s*$/);
    if (fence) {
      if (inCodeBlock) {
        flushCodeBlock();
      } else {
        inCodeBlock = true;
        codeLang = fence[1] || '';
        codeLines = [];
      }
      i += 1;
      continue;
    }

    if (inCodeBlock) {
      codeLines.push(line);
      i += 1;
      continue;
    }

    // blockquote
    if (/^\s*&gt;\s+/.test(line)) {
      const bqLines = [];
      let j = i;
      while (j < lines.length && /^\s*&gt;\s+/.test(lines[j])) {
        bqLines.push(lines[j].replace(/^\s*&gt;\s+/, ''));
        j += 1;
      }
      out.push(`<blockquote class="md-bq">${parseInline(bqLines.join('<br/>'))}</blockquote>`);
      i = j;
      continue;
    }

    // headings
    const h = line.match(/^(#{1,3})\s+(.*)$/);
    if (h) {
      const level = h[1].length;
      out.push(`<h${level} class="md-h${level}">${parseInline(h[2])}</h${level}>`);
      i += 1;
      continue;
    }

    // lists
    if (isUl(line) || isOl(line)) {
      const listType = isOl(line) ? 'ol' : 'ul';
      const items = [];
      let j = i;
      while (j < lines.length && (isUl(lines[j]) || isOl(lines[j]))) {
        const itemText = lines[j].replace(/^(\s*)([-*]|\d+\.)\s+/, '');
        items.push(`<li>${parseInline(itemText)}</li>`);
        j += 1;
      }
      out.push(`<${listType} class="md-list">${items.join('')}</${listType}>`);
      i = j;
      continue;
    }

    // empty -> spacing
    if (line.trim() === '') {
      out.push('<div class="md-spacer"></div>');
      i += 1;
      continue;
    }

    // paragraph
    out.push(`<p class="md-p">${parseInline(line)}</p>`);
    i += 1;
  }

  flushCodeBlock();
  return out.join('\n');
}

function createBlankNote() {
  const ts = nowTs();
  return {
    id: generateId(),
    title: '',
    content: '',
    tags: [],
    createdAt: ts,
    lastModified: ts,
    pinned: false,
  };
}

function safeLoadFromStorage() {
  const raw = localStorage.getItem(STORAGE_KEY);
  if (!raw) {
    return { version: STORAGE_VERSION, notes: [], trash: [], ui: { theme: 'light' } };
  }
  const parsed = safeJsonParse(raw, null);
  if (!parsed || typeof parsed !== 'object') {
    return { version: STORAGE_VERSION, notes: [], trash: [], ui: { theme: 'light' } };
  }
  return {
    version: STORAGE_VERSION,
    notes: Array.isArray(parsed.notes) ? parsed.notes : [],
    trash: Array.isArray(parsed.trash) ? parsed.trash : [],
    ui: parsed.ui && typeof parsed.ui === 'object' ? parsed.ui : { theme: 'light' },
  };
}

function safeSaveToStorage(data) {
  // localStorage can throw quota errors.
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
    return { ok: true, error: null };
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return { ok: false, error: message };
  }
}

function isMacPlatform() {
  return /Mac|iPhone|iPad|iPod/.test(navigator.platform);
}

function shortcutLabel(keys) {
  const mac = isMacPlatform();
  return keys
    .map((k) => {
      if (k === 'Mod') return mac ? '⌘' : 'Ctrl';
      if (k === 'Shift') return mac ? '⇧' : 'Shift';
      if (k === 'Alt') return mac ? '⌥' : 'Alt';
      if (k === 'Enter') return 'Enter';
      if (k === 'Esc') return 'Esc';
      return k.toUpperCase();
    })
    .join(mac ? '' : '+');
}

// PUBLIC_INTERFACE
function App() {
  const initial = useMemo(() => safeLoadFromStorage(), []);
  const [notes, setNotes] = useState(initial.notes);
  const [trash, setTrash] = useState(initial.trash);
  const [theme, setTheme] = useState(initial.ui.theme === 'dark' ? 'dark' : 'light');

  const [selectedId, setSelectedId] = useState(() => (initial.notes[0]?.id ? initial.notes[0].id : null));
  const [view, setView] = useState('notes'); // 'notes' | 'trash' | 'tags' | 'settings'

  const [search, setSearch] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');
  const [tagFilter, setTagFilter] = useState(null);
  const [sortMode, setSortMode] = useState('lastModifiedDesc');

  const [isSidebarOpen, setIsSidebarOpen] = useState(false); // for mobile drawer
  const [editorMode, setEditorMode] = useState('write'); // 'write' | 'preview' | 'split'

  const [saveStatus, setSaveStatus] = useState('idle'); // idle | dirty | saving | saved | error
  const [storageError, setStorageError] = useState(null);

  const [modal, setModal] = useState(null); // {type, ...payload}

  const titleRef = useRef(null);
  const searchRef = useRef(null);

  const pendingSaveTimer = useRef(null);
  const lastSavedSnapshot = useRef(JSON.stringify({ notes, trash, theme }));

  // Apply theme via data attribute; template previously did this.
  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme);
  }, [theme]);

  // Keep debounced search for performance.
  useEffect(() => {
    const t = window.setTimeout(() => setDebouncedSearch(search), 150);
    return () => window.clearTimeout(t);
  }, [search]);

  const persistAll = useCallback(
    (nextNotes, nextTrash, nextTheme) => {
      const payload = {
        version: STORAGE_VERSION,
        notes: nextNotes,
        trash: nextTrash,
        ui: { theme: nextTheme },
      };
      const res = safeSaveToStorage(payload);
      if (!res.ok) {
        setStorageError(res.error || 'Failed to save to storage.');
        setSaveStatus('error');
      } else {
        setStorageError(null);
        setSaveStatus('saved');
        lastSavedSnapshot.current = JSON.stringify({ notes: nextNotes, trash: nextTrash, theme: nextTheme });
      }
      return res;
    },
    [setStorageError],
  );

  const schedulePersist = useCallback(
    (nextNotes, nextTrash, nextTheme) => {
      setSaveStatus('dirty');
      if (pendingSaveTimer.current) {
        window.clearTimeout(pendingSaveTimer.current);
      }
      pendingSaveTimer.current = window.setTimeout(() => {
        setSaveStatus('saving');
        persistAll(nextNotes, nextTrash, nextTheme);
      }, 750);
    },
    [persistAll],
  );

  // External storage change (multi-tab). Warn user.
  useEffect(() => {
    const onStorage = (e) => {
      if (e.key !== STORAGE_KEY) return;
      // If current snapshot differs from the incoming value, warn about conflicts.
      const incoming = e.newValue || '';
      const current = JSON.stringify({ version: STORAGE_VERSION, notes, trash, ui: { theme } });
      if (incoming && incoming !== current) {
        setModal({
          type: 'info',
          title: 'Changes detected in another tab',
          message:
            'This app was updated in another browser tab. To avoid conflicts, consider refreshing. Your current tab may overwrite the other changes if you keep editing.',
          primary: { label: 'OK', action: () => setModal(null) },
          secondary: { label: 'Refresh', action: () => window.location.reload() },
        });
      }
    };
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, [notes, trash, theme]);

  const selectedNote = useMemo(() => notes.find((n) => n.id === selectedId) || null, [notes, selectedId]);
  const selectedTrashNote = useMemo(() => trash.find((n) => n.id === selectedId) || null, [trash, selectedId]);

  const allTags = useMemo(() => {
    const counts = new Map();
    for (const n of notes) {
      for (const t of n.tags || []) {
        counts.set(t, (counts.get(t) || 0) + 1);
      }
    }
    return Array.from(counts.entries())
      .map(([tag, count]) => ({ tag, count }))
      .sort((a, b) => a.tag.localeCompare(b.tag));
  }, [notes]);

  const filteredSortedNotes = useMemo(() => {
    const q = normalizeText(debouncedSearch);
    const base = notes.filter((n) => {
      if (tagFilter && !(n.tags || []).includes(tagFilter)) return false;
      if (!q) return true;
      return normalizeText(n.title).includes(q) || normalizeText(n.content).includes(q);
    });

    const pinned = base.filter((n) => n.pinned);
    const others = base.filter((n) => !n.pinned);

    const sortFn = (a, b) => {
      if (sortMode === 'createdDesc') return (b.createdAt || 0) - (a.createdAt || 0);
      if (sortMode === 'titleAsc') return (a.title || '').localeCompare(b.title || '');
      if (sortMode === 'titleDesc') return (b.title || '').localeCompare(a.title || '');
      // default: lastModifiedDesc
      return (b.lastModified || 0) - (a.lastModified || 0);
    };

    pinned.sort(sortFn);
    others.sort(sortFn);
    return [...pinned, ...others];
  }, [notes, debouncedSearch, tagFilter, sortMode]);

  // Virtual list for sidebar notes
  const listContainerRef = useRef(null);
  const [listScrollTop, setListScrollTop] = useState(0);
  const [listViewportHeight, setListViewportHeight] = useState(600);

  useEffect(() => {
    const el = listContainerRef.current;
    if (!el) return undefined;

    const onScroll = () => setListScrollTop(el.scrollTop);
    onScroll();
    el.addEventListener('scroll', onScroll);

    const ro = new ResizeObserver(() => {
      setListViewportHeight(el.clientHeight || 600);
    });
    ro.observe(el);

    return () => {
      el.removeEventListener('scroll', onScroll);
      ro.disconnect();
    };
  }, []);

  const VIRTUAL_ROW_H = 92;
  const VIRTUAL_OVERSCAN = 6;

  const virtual = useMemo(() => {
    const total = filteredSortedNotes.length;
    const startIdx = Math.max(0, Math.floor(listScrollTop / VIRTUAL_ROW_H) - VIRTUAL_OVERSCAN);
    const visibleCount = Math.ceil(listViewportHeight / VIRTUAL_ROW_H) + VIRTUAL_OVERSCAN * 2;
    const endIdx = Math.min(total, startIdx + visibleCount);
    const items = filteredSortedNotes.slice(startIdx, endIdx);
    const topPad = startIdx * VIRTUAL_ROW_H;
    const bottomPad = Math.max(0, (total - endIdx) * VIRTUAL_ROW_H);
    return { items, topPad, bottomPad, total };
  }, [filteredSortedNotes, listScrollTop, listViewportHeight]);

  const focusTitleSoon = useCallback(() => {
    window.setTimeout(() => {
      if (titleRef.current) titleRef.current.focus();
    }, 0);
  }, []);

  const focusSearchSoon = useCallback(() => {
    window.setTimeout(() => {
      if (searchRef.current) searchRef.current.focus();
    }, 0);
  }, []);

  const selectNote = useCallback(
    (id) => {
      setSelectedId(id);
      if (window.innerWidth < 768) {
        setIsSidebarOpen(false);
      }
    },
    [setSelectedId],
  );

  // PUBLIC_INTERFACE
  const toggleTheme = useCallback(() => {
    const next = theme === 'light' ? 'dark' : 'light';
    setTheme(next);
    schedulePersist(notes, trash, next);
  }, [theme, notes, trash, schedulePersist]);

  const createNewNote = useCallback(() => {
    const n = createBlankNote();
    const nextNotes = [n, ...notes];
    setNotes(nextNotes);
    setSelectedId(n.id);
    setView('notes');
    setTagFilter(null);
    setSearch('');
    schedulePersist(nextNotes, trash, theme);
    focusTitleSoon();
    if (window.innerWidth < 768) {
      setIsSidebarOpen(false);
    }
  }, [notes, trash, theme, schedulePersist, focusTitleSoon]);

  const updateSelectedNote = useCallback(
    (patch) => {
      if (!selectedNote) return;
      const nextNotes = notes.map((n) => {
        if (n.id !== selectedNote.id) return n;
        return { ...n, ...patch, lastModified: nowTs() };
      });
      setNotes(nextNotes);
      schedulePersist(nextNotes, trash, theme);
    },
    [notes, trash, theme, selectedNote, schedulePersist],
  );

  const togglePinned = useCallback(
    (id) => {
      const nextNotes = notes.map((n) => (n.id === id ? { ...n, pinned: !n.pinned, lastModified: nowTs() } : n));
      setNotes(nextNotes);
      schedulePersist(nextNotes, trash, theme);
    },
    [notes, trash, theme, schedulePersist],
  );

  const openDeleteModal = useCallback(() => {
    if (!selectedNote) return;
    setModal({
      type: 'confirmDelete',
      title: 'Delete note?',
      message: 'Are you sure you want to delete this note? This action cannot be undone (unless restored from Trash).',
      primary: { label: 'Delete', danger: true },
      secondary: { label: 'Cancel' },
      noteId: selectedNote.id,
    });
  }, [selectedNote]);

  const moveToTrash = useCallback(
    (noteId) => {
      const toDelete = notes.find((n) => n.id === noteId);
      if (!toDelete) return;

      const nextNotes = notes.filter((n) => n.id !== noteId);
      const nextTrash = [{ ...toDelete, deletedAt: nowTs() }, ...trash];

      setNotes(nextNotes);
      setTrash(nextTrash);

      // Select another note if needed.
      if (selectedId === noteId) {
        setSelectedId(nextNotes[0]?.id || null);
      }

      schedulePersist(nextNotes, nextTrash, theme);
    },
    [notes, trash, selectedId, theme, schedulePersist],
  );

  const restoreFromTrash = useCallback(
    (noteId) => {
      const found = trash.find((n) => n.id === noteId);
      if (!found) return;
      const nextTrash = trash.filter((n) => n.id !== noteId);
      const nextNotes = [{ ...found, deletedAt: undefined, lastModified: nowTs() }, ...notes];
      setTrash(nextTrash);
      setNotes(nextNotes);
      setView('notes');
      setSelectedId(found.id);
      schedulePersist(nextNotes, nextTrash, theme);
    },
    [trash, notes, theme, schedulePersist],
  );

  const permanentlyDeleteFromTrash = useCallback(
    (noteId) => {
      const nextTrash = trash.filter((n) => n.id !== noteId);
      setTrash(nextTrash);
      if (selectedId === noteId) {
        setSelectedId(null);
      }
      schedulePersist(notes, nextTrash, theme);
    },
    [trash, selectedId, notes, theme, schedulePersist],
  );

  const addTagToSelected = useCallback(
    (tag) => {
      if (!selectedNote) return;
      const t = (tag || '').trim();
      if (!t) return;
      const existing = new Set(selectedNote.tags || []);
      existing.add(t);
      updateSelectedNote({ tags: Array.from(existing) });
    },
    [selectedNote, updateSelectedNote],
  );

  const removeTagFromSelected = useCallback(
    (tag) => {
      if (!selectedNote) return;
      const next = (selectedNote.tags || []).filter((t) => t !== tag);
      updateSelectedNote({ tags: next });
    },
    [selectedNote, updateSelectedNote],
  );

  const renameTagGlobally = useCallback(
    (fromTag, toTag) => {
      const from = (fromTag || '').trim();
      const to = (toTag || '').trim();
      if (!from || !to) return;
      const nextNotes = notes.map((n) => {
        const tags = n.tags || [];
        if (!tags.includes(from)) return n;
        const nextTags = tags.map((t) => (t === from ? to : t));
        // ensure unique
        const uniq = Array.from(new Set(nextTags));
        return { ...n, tags: uniq, lastModified: nowTs() };
      });
      setNotes(nextNotes);
      if (tagFilter === from) setTagFilter(to);
      schedulePersist(nextNotes, trash, theme);
    },
    [notes, trash, theme, tagFilter, schedulePersist],
  );

  const deleteTagGlobally = useCallback(
    (tag) => {
      const t = (tag || '').trim();
      if (!t) return;
      const nextNotes = notes.map((n) => {
        const tags = (n.tags || []).filter((x) => x !== t);
        if ((n.tags || []).length === tags.length) return n;
        return { ...n, tags, lastModified: nowTs() };
      });
      setNotes(nextNotes);
      if (tagFilter === t) setTagFilter(null);
      schedulePersist(nextNotes, trash, theme);
    },
    [notes, trash, theme, tagFilter, schedulePersist],
  );

  const exportAll = useCallback(() => {
    const payload = {
      version: STORAGE_VERSION,
      exportedAt: nowTs(),
      notes,
      trash,
      ui: { theme },
    };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);

    const a = document.createElement('a');
    a.href = url;
    a.download = `notes-backup-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(url);
  }, [notes, trash, theme]);

  const importFromFile = useCallback(
    async (file, mode) => {
      try {
        const text = await file.text();
        const parsed = safeJsonParse(text, null);
        if (!parsed || typeof parsed !== 'object') {
          setModal({
            type: 'info',
            title: 'Import failed',
            message: 'The selected file is not a valid JSON backup.',
            primary: { label: 'OK', action: () => setModal(null) },
          });
          return;
        }
        const incomingNotes = Array.isArray(parsed.notes) ? parsed.notes : [];
        const incomingTrash = Array.isArray(parsed.trash) ? parsed.trash : [];

        if (mode === 'replace') {
          setNotes(incomingNotes);
          setTrash(incomingTrash);
          setSelectedId(incomingNotes[0]?.id || null);
          setView('notes');
          schedulePersist(incomingNotes, incomingTrash, theme);
        } else {
          // merge: by id; if id collides, keep current and generate new id for incoming.
          const existingIds = new Set(notes.map((n) => n.id));
          const mergedNotes = [...notes];
          for (const n of incomingNotes) {
            const safeN = { ...n };
            if (!safeN.id || existingIds.has(safeN.id)) {
              safeN.id = generateId();
            }
            existingIds.add(safeN.id);
            mergedNotes.push(safeN);
          }

          const existingTrashIds = new Set(trash.map((n) => n.id));
          const mergedTrash = [...trash];
          for (const n of incomingTrash) {
            const safeN = { ...n };
            if (!safeN.id || existingTrashIds.has(safeN.id)) {
              safeN.id = generateId();
            }
            existingTrashIds.add(safeN.id);
            mergedTrash.push(safeN);
          }

          setNotes(mergedNotes);
          setTrash(mergedTrash);
          schedulePersist(mergedNotes, mergedTrash, theme);
        }
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        setModal({
          type: 'info',
          title: 'Import failed',
          message: msg,
          primary: { label: 'OK', action: () => setModal(null) },
        });
      }
    },
    [notes, trash, theme, schedulePersist],
  );

  const clearAllData = useCallback(() => {
    setModal({
      type: 'confirm',
      title: 'Clear all data?',
      message:
        'This will permanently remove ALL notes and trash from this browser. Consider exporting a backup first.',
      primary: { label: 'Clear all', danger: true },
      secondary: { label: 'Cancel' },
      onConfirm: () => {
        const nextNotes = [];
        const nextTrash = [];
        setNotes(nextNotes);
        setTrash(nextTrash);
        setSelectedId(null);
        schedulePersist(nextNotes, nextTrash, theme);
        setModal(null);
      },
    });
  }, [theme, schedulePersist]);

  // Keyboard shortcuts.
  useEffect(() => {
    const onKeyDown = (e) => {
      const mod = isMacPlatform() ? e.metaKey : e.ctrlKey;
      const key = e.key.toLowerCase();

      // Escape closes modals, clears search, closes sidebar on mobile
      if (e.key === 'Escape') {
        if (modal) {
          setModal(null);
          return;
        }
        if (search) {
          setSearch('');
          setTagFilter(null);
          return;
        }
        if (isSidebarOpen) {
          setIsSidebarOpen(false);
        }
        return;
      }

      // Ctrl/Cmd+? help
      if (mod && (key === '?' || (e.shiftKey && key === '/'))) {
        e.preventDefault();
        setModal({ type: 'help' });
        return;
      }

      if (!mod) return;

      if (key === 'n') {
        e.preventDefault();
        createNewNote();
      } else if (key === 'f') {
        e.preventDefault();
        focusSearchSoon();
        if (window.innerWidth < 768) setIsSidebarOpen(true);
      } else if (key === 's') {
        e.preventDefault();
        // manual save triggers immediate persist
        setSaveStatus('saving');
        persistAll(notes, trash, theme);
      } else if (key === 'd') {
        e.preventDefault();
        if (view === 'notes') openDeleteModal();
      }
    };

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [
    modal,
    search,
    isSidebarOpen,
    notes,
    trash,
    theme,
    view,
    createNewNote,
    focusSearchSoon,
    persistAll,
    openDeleteModal,
  ]);

  // Cleanup timer
  useEffect(() => {
    return () => {
      if (pendingSaveTimer.current) window.clearTimeout(pendingSaveTimer.current);
    };
  }, []);

  const saveStatusText = useMemo(() => {
    if (saveStatus === 'saving') return 'Saving…';
    if (saveStatus === 'saved') return 'All changes saved';
    if (saveStatus === 'error') return 'Save failed';
    if (saveStatus === 'dirty') return 'Unsaved changes';
    return '';
  }, [saveStatus]);

  const noteSnippet = useCallback((content) => {
    const c = (content || '').trim();
    if (!c) return 'Start typing…';
    const s = c.replaceAll('\n', ' ').slice(0, 110);
    return s.length < c.length ? `${s}…` : s;
  }, []);

  const activeNote = view === 'notes' ? selectedNote : view === 'trash' ? selectedTrashNote : null;

  const renderedPreviewHtml = useMemo(() => {
    if (!activeNote) return '';
    return renderMarkdownToHtml(activeNote.content || '');
  }, [activeNote]);

  const storageStats = useMemo(() => {
    const payload = localStorage.getItem(STORAGE_KEY) || '';
    const bytes = countBytesApprox(payload);
    return {
      notes: notes.length,
      trash: trash.length,
      bytes,
    };
  }, [notes.length, trash.length]);

  const renderModal = () => {
    if (!modal) return null;

    const close = () => setModal(null);

    if (modal.type === 'help') {
      const shortcuts = [
        { label: 'New note', keys: shortcutLabel(['Mod', 'N']) },
        { label: 'Focus search', keys: shortcutLabel(['Mod', 'F']) },
        { label: 'Delete current note', keys: shortcutLabel(['Mod', 'D']) },
        { label: 'Save now', keys: shortcutLabel(['Mod', 'S']) },
        { label: 'Close dialogs / clear search', keys: shortcutLabel(['Esc']) },
        { label: 'Help', keys: shortcutLabel(['Mod', '?']) },
      ];
      return (
        <div className="modalOverlay" role="dialog" aria-modal="true" aria-label="Keyboard shortcuts">
          <div className="modal">
            <div className="modalHeader">
              <div className="modalTitle">Keyboard shortcuts</div>
              <button className="iconBtn" onClick={close} aria-label="Close">
                ✕
              </button>
            </div>
            <div className="modalBody">
              <div className="kbdList">
                {shortcuts.map((s) => (
                  <div className="kbdRow" key={s.label}>
                    <div className="kbdLabel">{s.label}</div>
                    <div className="kbdKeys">{s.keys}</div>
                  </div>
                ))}
              </div>
            </div>
            <div className="modalFooter">
              <button className="btn" onClick={close}>
                Close
              </button>
            </div>
          </div>
        </div>
      );
    }

    if (modal.type === 'markdownHelp') {
      return (
        <div className="modalOverlay" role="dialog" aria-modal="true" aria-label="Markdown help">
          <div className="modal">
            <div className="modalHeader">
              <div className="modalTitle">Markdown formatting</div>
              <button className="iconBtn" onClick={close} aria-label="Close">
                ✕
              </button>
            </div>
            <div className="modalBody">
              <div className="mdHelpGrid">
                <div className="mdHelpItem">
                  <div className="mdHelpLabel">Bold</div>
                  <div className="mdHelpCode">**bold**</div>
                </div>
                <div className="mdHelpItem">
                  <div className="mdHelpLabel">Italic</div>
                  <div className="mdHelpCode">*italic*</div>
                </div>
                <div className="mdHelpItem">
                  <div className="mdHelpLabel">Underline</div>
                  <div className="mdHelpCode">__underline__</div>
                </div>
                <div className="mdHelpItem">
                  <div className="mdHelpLabel">Strikethrough</div>
                  <div className="mdHelpCode">~~strike~~</div>
                </div>
                <div className="mdHelpItem">
                  <div className="mdHelpLabel">Heading</div>
                  <div className="mdHelpCode"># H1 / ## H2 / ### H3</div>
                </div>
                <div className="mdHelpItem">
                  <div className="mdHelpLabel">Quote</div>
                  <div className="mdHelpCode">&gt; quote</div>
                </div>
                <div className="mdHelpItem">
                  <div className="mdHelpLabel">Bullets</div>
                  <div className="mdHelpCode">- item</div>
                </div>
                <div className="mdHelpItem">
                  <div className="mdHelpLabel">Numbers</div>
                  <div className="mdHelpCode">1. item</div>
                </div>
                <div className="mdHelpItem">
                  <div className="mdHelpLabel">Inline code</div>
                  <div className="mdHelpCode">`code`</div>
                </div>
                <div className="mdHelpItem">
                  <div className="mdHelpLabel">Code block</div>
                  <div className="mdHelpCode">```js {'\n'}code{'\n'}```</div>
                </div>
                <div className="mdHelpItem">
                  <div className="mdHelpLabel">Link</div>
                  <div className="mdHelpCode">[text](https://…)</div>
                </div>
              </div>
            </div>
            <div className="modalFooter">
              <button className="btn" onClick={close}>
                Close
              </button>
            </div>
          </div>
        </div>
      );
    }

    if (modal.type === 'info') {
      return (
        <div className="modalOverlay" role="dialog" aria-modal="true" aria-label={modal.title || 'Info'}>
          <div className="modal">
            <div className="modalHeader">
              <div className="modalTitle">{modal.title || 'Info'}</div>
              <button className="iconBtn" onClick={close} aria-label="Close">
                ✕
              </button>
            </div>
            <div className="modalBody">
              <div className="modalText">{modal.message || ''}</div>
            </div>
            <div className="modalFooter">
              {modal.secondary ? (
                <button className="btn btnSecondary" onClick={modal.secondary.action}>
                  {modal.secondary.label}
                </button>
              ) : null}
              <button className="btn" onClick={modal.primary?.action || close}>
                {modal.primary?.label || 'OK'}
              </button>
            </div>
          </div>
        </div>
      );
    }

    if (modal.type === 'confirmDelete') {
      return (
        <div className="modalOverlay" role="dialog" aria-modal="true" aria-label={modal.title || 'Confirm delete'}>
          <div className="modal">
            <div className="modalHeader">
              <div className="modalTitle">{modal.title}</div>
              <button className="iconBtn" onClick={close} aria-label="Close">
                ✕
              </button>
            </div>
            <div className="modalBody">
              <div className="modalText">{modal.message}</div>
            </div>
            <div className="modalFooter">
              <button className="btn btnSecondary" onClick={close}>
                {modal.secondary?.label || 'Cancel'}
              </button>
              <button
                className="btn btnDanger"
                onClick={() => {
                  moveToTrash(modal.noteId);
                  setModal(null);
                }}
              >
                {modal.primary?.label || 'Delete'}
              </button>
            </div>
          </div>
        </div>
      );
    }

    if (modal.type === 'confirm') {
      return (
        <div className="modalOverlay" role="dialog" aria-modal="true" aria-label={modal.title || 'Confirm'}>
          <div className="modal">
            <div className="modalHeader">
              <div className="modalTitle">{modal.title}</div>
              <button className="iconBtn" onClick={close} aria-label="Close">
                ✕
              </button>
            </div>
            <div className="modalBody">
              <div className="modalText">{modal.message}</div>
            </div>
            <div className="modalFooter">
              <button className="btn btnSecondary" onClick={close}>
                {modal.secondary?.label || 'Cancel'}
              </button>
              <button className={modal.primary?.danger ? 'btn btnDanger' : 'btn'} onClick={modal.onConfirm}>
                {modal.primary?.label || 'OK'}
              </button>
            </div>
          </div>
        </div>
      );
    }

    return null;
  };

  const TagPill = ({ tag, onClick, onRemove, removable }) => {
    return (
      <button
        type="button"
        className={`tagPill ${removable ? 'tagPillRemovable' : ''}`}
        onClick={onClick}
        aria-label={removable ? `Tag ${tag}` : `Filter by tag ${tag}`}
      >
        <span className="tagDot" style={{ background: tagColorFromName(tag) }} aria-hidden="true" />
        <span className="tagText">{tag}</span>
        {removable ? (
          <span
            className="tagRemove"
            role="button"
            tabIndex={0}
            aria-label={`Remove tag ${tag}`}
            onClick={(e) => {
              e.stopPropagation();
              onRemove();
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                onRemove();
              }
            }}
          >
            ✕
          </span>
        ) : null}
      </button>
    );
  };

  const sidebarHeaderTitle = useMemo(() => {
    if (view === 'trash') return 'Trash';
    if (view === 'tags') return 'Tags';
    if (view === 'settings') return 'Settings';
    return 'Notes';
  }, [view]);

  const NoNotesState = () => (
    <div className="emptyState">
      <div className="emptyTitle">No notes yet</div>
      <div className="emptyText">Create your first note to get started!</div>
      <button className="btn btnLarge" onClick={createNewNote}>
        New Note
      </button>
    </div>
  );

  const NoSearchState = () => (
    <div className="emptyState">
      <div className="emptyTitle">No notes found</div>
      <div className="emptyText">Try a different search or clear filters.</div>
      <button
        className="btn btnSecondary"
        onClick={() => {
          setSearch('');
          setTagFilter(null);
        }}
      >
        Clear search
      </button>
    </div>
  );

  const EditorEmptyState = () => (
    <div className="emptyState">
      <div className="emptyTitle">Select a note</div>
      <div className="emptyText">Choose a note from the list, or create a new one.</div>
      <button className="btn" onClick={createNewNote}>
        New Note
      </button>
    </div>
  );

  // Small helper that inserts markdown around current selection in a textarea.
  const wrapSelection = useCallback((before, after) => {
    if (!activeNote || view !== 'notes') return;
    const textarea = document.activeElement?.classList?.contains('editorTextarea')
      ? document.activeElement
      : null;
    // We avoid direct DOM manipulation except to read selection and set value via controlled state update.
    if (!textarea || typeof textarea.selectionStart !== 'number') {
      updateSelectedNote({ content: `${activeNote.content || ''}${before}${after}` });
      return;
    }
    const start = textarea.selectionStart;
    const end = textarea.selectionEnd;
    const text = activeNote.content || '';
    const selected = text.slice(start, end);
    const next = `${text.slice(0, start)}${before}${selected}${after}${text.slice(end)}`;
    updateSelectedNote({ content: next });

    window.setTimeout(() => {
      // Restore selection roughly inside the wrapper.
      try {
        textarea.focus();
        textarea.setSelectionRange(start + before.length, end + before.length);
      } catch {
        // ignore
      }
    }, 0);
  }, [activeNote, updateSelectedNote, view]);

  const insertLinePrefix = useCallback((prefix) => {
    if (!activeNote || view !== 'notes') return;
    const textarea = document.activeElement?.classList?.contains('editorTextarea')
      ? document.activeElement
      : null;
    if (!textarea || typeof textarea.selectionStart !== 'number') {
      updateSelectedNote({ content: `${activeNote.content || ''}\n${prefix}` });
      return;
    }
    const text = activeNote.content || '';
    const start = textarea.selectionStart;
    const end = textarea.selectionEnd;

    const before = text.slice(0, start);
    const selection = text.slice(start, end);
    const after = text.slice(end);

    const selectionLines = selection.split('\n');
    const prefixed = selectionLines.map((l) => `${prefix}${l}`).join('\n');
    const next = `${before}${prefixed}${after}`;
    updateSelectedNote({ content: next });
  }, [activeNote, updateSelectedNote, view]);

  const Sidebar = () => {
    const isNotesView = view === 'notes';
    return (
      <aside className={`sidebar ${isSidebarOpen ? 'sidebarOpen' : ''}`} aria-label="Notes sidebar">
        <div className="sidebarTop">
          <div className="brandRow">
            <div className="brandTitle">Simple Notes</div>
            <button
              className="iconBtn"
              onClick={() => setModal({ type: 'help' })}
              aria-label="Help (keyboard shortcuts)"
              title="Help"
            >
              ?
            </button>
            <button className="iconBtn" onClick={toggleTheme} aria-label="Toggle theme" title="Toggle theme">
              {theme === 'light' ? '🌙' : '☀️'}
            </button>
          </div>

          <div className="sidebarHeaderRow">
            <div className="sidebarTitle">{sidebarHeaderTitle}</div>
            {view === 'notes' ? (
              <button className="btn btnPrimary" onClick={createNewNote}>
                New Note
              </button>
            ) : null}
          </div>

          {view === 'notes' ? (
            <div className="sidebarControls">
              <div className="searchWrap">
                <input
                  ref={searchRef}
                  className="searchInput"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder="Search notes…"
                  aria-label="Search notes"
                />
                {search ? (
                  <button
                    className="iconBtn iconBtnInline"
                    onClick={() => setSearch('')}
                    aria-label="Clear search"
                    title="Clear"
                  >
                    ✕
                  </button>
                ) : null}
              </div>

              <div className="sortRow">
                <select
                  className="select"
                  value={sortMode}
                  onChange={(e) => setSortMode(e.target.value)}
                  aria-label="Sort notes"
                >
                  {NOTE_SORTS.map((s) => (
                    <option value={s.value} key={s.value}>
                      {s.label}
                    </option>
                  ))}
                </select>
                {tagFilter ? (
                  <button className="btn btnSmall btnSecondary" onClick={() => setTagFilter(null)}>
                    All Notes
                  </button>
                ) : null}
              </div>

              {allTags.length ? (
                <div className="tagFilterRow" aria-label="Tag filters">
                  {allTags.slice(0, 10).map((t) => (
                    <TagPill key={t.tag} tag={t.tag} onClick={() => setTagFilter(t.tag)} />
                  ))}
                  {allTags.length > 10 ? <div className="tagMore">+{allTags.length - 10}</div> : null}
                </div>
              ) : null}
            </div>
          ) : null}
        </div>

        <nav className="sidebarNav" aria-label="Sidebar navigation">
          <button
            className={`navBtn ${view === 'notes' ? 'navBtnActive' : ''}`}
            onClick={() => setView('notes')}
          >
            Notes <span className="navCount">{notes.length}</span>
          </button>
          <button
            className={`navBtn ${view === 'trash' ? 'navBtnActive' : ''}`}
            onClick={() => setView('trash')}
          >
            Trash <span className="navCount">{trash.length}</span>
          </button>
          <button className={`navBtn ${view === 'tags' ? 'navBtnActive' : ''}`} onClick={() => setView('tags')}>
            Tags <span className="navCount">{allTags.length}</span>
          </button>
          <button
            className={`navBtn ${view === 'settings' ? 'navBtnActive' : ''}`}
            onClick={() => setView('settings')}
          >
            Settings
          </button>
        </nav>

        {isNotesView ? (
          <div className="notesList" ref={listContainerRef} aria-label="Notes list">
            {notes.length === 0 ? (
              <NoNotesState />
            ) : filteredSortedNotes.length === 0 ? (
              <NoSearchState />
            ) : (
              <div className="virtualList">
                <div style={{ height: `${virtual.topPad}px` }} />
                {virtual.items.map((n) => (
                  <button
                    key={n.id}
                    className={`noteCard ${selectedId === n.id ? 'noteCardActive' : ''}`}
                    onClick={() => selectNote(n.id)}
                  >
                    <div className="noteCardTop">
                      <div className="noteTitle">{n.title?.trim() ? n.title : 'Untitled'}</div>
                      <button
                        type="button"
                        className={`iconBtn iconBtnStar ${n.pinned ? 'iconBtnStarOn' : ''}`}
                        onClick={(e) => {
                          e.stopPropagation();
                          togglePinned(n.id);
                        }}
                        aria-label={n.pinned ? 'Unpin note' : 'Pin note'}
                        title={n.pinned ? 'Unpin' : 'Pin'}
                      >
                        ★
                      </button>
                    </div>
                    <div className="noteMeta">
                      <div className="noteTime">{formatRelativeTime(n.lastModified)}</div>
                    </div>
                    <div className="noteSnippet">{noteSnippet(n.content)}</div>
                    {n.tags?.length ? (
                      <div className="noteTags">
                        {n.tags.slice(0, 3).map((t) => (
                          <span className="noteTagBadge" key={t} style={{ borderColor: tagColorFromName(t) }}>
                            {t}
                          </span>
                        ))}
                        {n.tags.length > 3 ? <span className="noteTagMore">+{n.tags.length - 3}</span> : null}
                      </div>
                    ) : null}
                  </button>
                ))}
                <div style={{ height: `${virtual.bottomPad}px` }} />
              </div>
            )}
          </div>
        ) : null}

        {view === 'trash' ? (
          <div className="notesList" aria-label="Trash list">
            {trash.length === 0 ? (
              <div className="emptyState">
                <div className="emptyTitle">Trash is empty</div>
                <div className="emptyText">Deleted notes will appear here.</div>
              </div>
            ) : (
              <div className="trashList">
                {trash
                  .slice()
                  .sort((a, b) => (b.deletedAt || 0) - (a.deletedAt || 0))
                  .map((n) => (
                    <button
                      key={n.id}
                      className={`noteCard ${selectedId === n.id ? 'noteCardActive' : ''}`}
                      onClick={() => selectNote(n.id)}
                    >
                      <div className="noteCardTop">
                        <div className="noteTitle">{n.title?.trim() ? n.title : 'Untitled'}</div>
                      </div>
                      <div className="noteMeta">
                        <div className="noteTime">Deleted {formatRelativeTime(n.deletedAt || n.lastModified)}</div>
                      </div>
                      <div className="noteSnippet">{noteSnippet(n.content)}</div>
                      <div className="trashActions">
                        <button
                          className="btn btnSmall"
                          onClick={(e) => {
                            e.stopPropagation();
                            restoreFromTrash(n.id);
                          }}
                        >
                          Restore
                        </button>
                        <button
                          className="btn btnSmall btnDanger"
                          onClick={(e) => {
                            e.stopPropagation();
                            setModal({
                              type: 'confirm',
                              title: 'Permanently delete?',
                              message: 'This will remove the note from Trash permanently.',
                              primary: { label: 'Delete permanently', danger: true },
                              secondary: { label: 'Cancel' },
                              onConfirm: () => {
                                permanentlyDeleteFromTrash(n.id);
                                setModal(null);
                              },
                            });
                          }}
                        >
                          Delete
                        </button>
                      </div>
                    </button>
                  ))}
              </div>
            )}
          </div>
        ) : null}

        {view === 'tags' ? (
          <div className="panelScroll" aria-label="Tags manager">
            <div className="panelSectionTitle">All tags</div>
            {allTags.length === 0 ? (
              <div className="emptyState compact">
                <div className="emptyTitle">No tags yet</div>
                <div className="emptyText">Add tags to a note to see them here.</div>
              </div>
            ) : (
              <div className="tagManagerList">
                {allTags.map((t) => (
                  <div className="tagManagerRow" key={t.tag}>
                    <div className="tagManagerLeft">
                      <span className="tagDot" style={{ background: tagColorFromName(t.tag) }} aria-hidden="true" />
                      <span className="tagManagerName">{t.tag}</span>
                      <span className="tagManagerCount">{t.count}</span>
                    </div>
                    <div className="tagManagerRight">
                      <button
                        className="btn btnSmall btnSecondary"
                        onClick={() =>
                          setModal({
                            type: 'renameTag',
                            from: t.tag,
                          })
                        }
                      >
                        Rename
                      </button>
                      <button
                        className="btn btnSmall btnDanger"
                        onClick={() =>
                          setModal({
                            type: 'confirm',
                            title: 'Delete tag?',
                            message: `Remove tag "${t.tag}" from all notes?`,
                            primary: { label: 'Delete tag', danger: true },
                            secondary: { label: 'Cancel' },
                            onConfirm: () => {
                              deleteTagGlobally(t.tag);
                              setModal(null);
                            },
                          })
                        }
                      >
                        Delete
                      </button>
                      <button
                        className="btn btnSmall"
                        onClick={() => {
                          setView('notes');
                          setTagFilter(t.tag);
                          setSearch('');
                        }}
                      >
                        Filter
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        ) : null}

        {view === 'settings' ? (
          <div className="panelScroll" aria-label="Settings">
            <div className="panelSectionTitle">Backup</div>
            <div className="settingsRow">
              <button className="btn" onClick={exportAll}>
                Export all notes (JSON)
              </button>
            </div>

            <div className="panelSectionTitle">Import</div>
            <div className="settingsRow">
              <label className="fileLabel">
                <input
                  className="fileInput"
                  type="file"
                  accept="application/json"
                  onChange={(e) => {
                    const f = e.target.files?.[0];
                    if (!f) return;
                    setModal({ type: 'import', file: f });
                    e.target.value = '';
                  }}
                />
                Choose backup file…
              </label>
            </div>

            <div className="panelSectionTitle">Storage</div>
            <div className="settingsRow">
              <div className="statRow">
                <div className="statLabel">Notes</div>
                <div className="statValue">{storageStats.notes}</div>
              </div>
              <div className="statRow">
                <div className="statLabel">Trash</div>
                <div className="statValue">{storageStats.trash}</div>
              </div>
              <div className="statRow">
                <div className="statLabel">Approx. used</div>
                <div className="statValue">{Math.round(storageStats.bytes / 1024)} KB</div>
              </div>
            </div>

            <div className="panelSectionTitle dangerTitle">Danger zone</div>
            <div className="settingsRow">
              <button className="btn btnDanger" onClick={clearAllData}>
                Clear all data
              </button>
            </div>
          </div>
        ) : null}
      </aside>
    );
  };

  const ImportModal = () => {
    if (!modal || modal.type !== 'import') return null;
    const file = modal.file;
    return (
      <div className="modalOverlay" role="dialog" aria-modal="true" aria-label="Import notes">
        <div className="modal">
          <div className="modalHeader">
            <div className="modalTitle">Import notes</div>
            <button className="iconBtn" onClick={() => setModal(null)} aria-label="Close">
              ✕
            </button>
          </div>
          <div className="modalBody">
            <div className="modalText">
              Import from <strong>{file?.name}</strong>. You can merge with existing notes or replace everything.
            </div>
          </div>
          <div className="modalFooter">
            <button className="btn btnSecondary" onClick={() => setModal(null)}>
              Cancel
            </button>
            <button
              className="btn"
              onClick={() => {
                importFromFile(file, 'merge');
                setModal(null);
              }}
            >
              Merge
            </button>
            <button
              className="btn btnDanger"
              onClick={() => {
                setModal({
                  type: 'confirm',
                  title: 'Replace all notes?',
                  message: 'This will overwrite your current notes and trash with the imported backup.',
                  primary: { label: 'Replace', danger: true },
                  secondary: { label: 'Cancel' },
                  onConfirm: () => {
                    importFromFile(file, 'replace');
                    setModal(null);
                  },
                });
              }}
            >
              Replace
            </button>
          </div>
        </div>
      </div>
    );
  };



  const MobileTopBar = () => (
    <div className="mobileTopBar">
      <button className="iconBtn" onClick={() => setIsSidebarOpen((v) => !v)} aria-label="Toggle sidebar">
        ☰
      </button>
      <div className="mobileTitle">Simple Notes</div>
      <button className="iconBtn" onClick={createNewNote} aria-label="New note">
        ＋
      </button>
    </div>
  );

  const Toolbar = () => (
    <div className="toolbar" role="toolbar" aria-label="Formatting toolbar">
      <button className="toolBtn" onClick={() => wrapSelection('**', '**')} title="Bold">
        <span className="toolBtnLabel">B</span>
      </button>
      <button className="toolBtn" onClick={() => wrapSelection('*', '*')} title="Italic">
        <span className="toolBtnLabel italic">I</span>
      </button>
      <button className="toolBtn" onClick={() => wrapSelection('__', '__')} title="Underline">
        <span className="toolBtnLabel underline">U</span>
      </button>
      <button className="toolBtn" onClick={() => wrapSelection('~~', '~~')} title="Strikethrough">
        <span className="toolBtnLabel strike">S</span>
      </button>
      <div className="toolSep" aria-hidden="true" />
      <button className="toolBtn" onClick={() => insertLinePrefix('# ')} title="Heading 1">
        H1
      </button>
      <button className="toolBtn" onClick={() => insertLinePrefix('## ')} title="Heading 2">
        H2
      </button>
      <button className="toolBtn" onClick={() => insertLinePrefix('### ')} title="Heading 3">
        H3
      </button>
      <div className="toolSep" aria-hidden="true" />
      <button className="toolBtn" onClick={() => insertLinePrefix('- ')} title="Bulleted list">
        • List
      </button>
      <button className="toolBtn" onClick={() => insertLinePrefix('1. ')} title="Numbered list">
        1. List
      </button>
      <button className="toolBtn" onClick={() => insertLinePrefix('> ')} title="Blockquote">
        “ Quote
      </button>
      <button className="toolBtn" onClick={() => wrapSelection('`', '`')} title="Inline code">
        {'</>'}
      </button>
      <button className="toolBtn" onClick={() => wrapSelection('\n```', '```\n')} title="Code block">
        {'{ }'}
      </button>
      <div className="toolSep" aria-hidden="true" />
      <button className="toolBtn" onClick={() => setModal({ type: 'markdownHelp' })} title="Formatting help">
        ?
      </button>

      <div className="toolbarRight">
        <div className="segmented" role="group" aria-label="Editor mode">
          <button
            className={`segBtn ${editorMode === 'write' ? 'segBtnActive' : ''}`}
            onClick={() => setEditorMode('write')}
          >
            Write
          </button>
          <button
            className={`segBtn ${editorMode === 'split' ? 'segBtnActive' : ''}`}
            onClick={() => setEditorMode('split')}
          >
            Split
          </button>
          <button
            className={`segBtn ${editorMode === 'preview' ? 'segBtnActive' : ''}`}
            onClick={() => setEditorMode('preview')}
          >
            Preview
          </button>
        </div>
      </div>
    </div>
  );

  const NoteEditor = () => {
    if (!activeNote || view !== 'notes') {
      return <EditorEmptyState />;
    }

    const tags = activeNote.tags || [];
    return (
      <div className="editorWrap" aria-label="Note editor">
        <div className="editorHeader">
          <input
            ref={titleRef}
            className="titleInput"
            value={activeNote.title || ''}
            onChange={(e) => updateSelectedNote({ title: e.target.value })}
            placeholder="Untitled"
            aria-label="Note title"
          />
          <div className="editorHeaderRight">
            <div className={`saveStatus ${saveStatus ? `saveStatus_${saveStatus}` : ''}`} aria-live="polite">
              {saveStatusText}
            </div>
            <button
              className={`iconBtn iconBtnStar ${activeNote.pinned ? 'iconBtnStarOn' : ''}`}
              onClick={() => togglePinned(activeNote.id)}
              aria-label={activeNote.pinned ? 'Unpin note' : 'Pin note'}
              title={activeNote.pinned ? 'Unpin' : 'Pin'}
            >
              ★
            </button>
            <button className="iconBtn" onClick={openDeleteModal} aria-label="Delete note" title="Delete">
              🗑
            </button>
          </div>
        </div>

        <div className="tagInputRow">
          <TagInput onAdd={addTagToSelected} placeholder="Add tag (Enter or comma)" />
        </div>

        {tags.length ? (
          <div className="tagsRow" aria-label="Tags">
            {tags.map((t) => (
              <TagPill
                key={t}
                tag={t}
                removable
                onClick={() => setTagFilter(t)}
                onRemove={() => removeTagFromSelected(t)}
              />
            ))}
          </div>
        ) : null}

        <Toolbar />

        <div className={`editorBody editorMode_${editorMode}`}>
          {editorMode !== 'preview' ? (
            <textarea
              className="editorTextarea"
              value={activeNote.content || ''}
              onChange={(e) => updateSelectedNote({ content: e.target.value })}
              placeholder="Start typing… (Markdown supported)"
              aria-label="Note content"
            />
          ) : null}
          {editorMode !== 'write' ? (
            <div className="preview" aria-label="Markdown preview">
              <div className="previewInner" dangerouslySetInnerHTML={{ __html: renderedPreviewHtml }} />
            </div>
          ) : null}
        </div>

        {storageError ? <div className="errorBanner">Storage error: {storageError}</div> : null}
      </div>
    );
  };

  const TrashViewer = () => {
    if (!activeNote || view !== 'trash') {
      return (
        <div className="emptyState">
          <div className="emptyTitle">Select a trashed note</div>
          <div className="emptyText">Choose a note in Trash to preview and restore or delete it.</div>
        </div>
      );
    }

    return (
      <div className="editorWrap" aria-label="Trash note viewer">
        <div className="editorHeader">
          <div className="trashTitle">{activeNote.title?.trim() ? activeNote.title : 'Untitled'}</div>
          <div className="editorHeaderRight">
            <button className="btn btnSmall" onClick={() => restoreFromTrash(activeNote.id)}>
              Restore
            </button>
            <button
              className="btn btnSmall btnDanger"
              onClick={() =>
                setModal({
                  type: 'confirm',
                  title: 'Permanently delete?',
                  message: 'This will remove the note from Trash permanently.',
                  primary: { label: 'Delete permanently', danger: true },
                  secondary: { label: 'Cancel' },
                  onConfirm: () => {
                    permanentlyDeleteFromTrash(activeNote.id);
                    setModal(null);
                  },
                })
              }
            >
              Delete
            </button>
          </div>
        </div>

        <div className="metaLine">
          <span>Created: {new Date(activeNote.createdAt || 0).toLocaleString()}</span>
          <span className="dotSep">•</span>
          <span>Last modified: {new Date(activeNote.lastModified || 0).toLocaleString()}</span>
          <span className="dotSep">•</span>
          <span>Deleted: {new Date(activeNote.deletedAt || 0).toLocaleString()}</span>
        </div>

        <div className="editorBody editorMode_preview">
          <div className="preview" aria-label="Markdown preview">
            <div className="previewInner" dangerouslySetInnerHTML={{ __html: renderMarkdownToHtml(activeNote.content || '') }} />
          </div>
        </div>
      </div>
    );
  };

  const MainPanel = () => {
    if (view === 'trash') return <TrashViewer />;
    if (view === 'tags') {
      return (
        <div className="panelScroll">
          <div className="panelSectionTitle">Tag management</div>
          <div className="panelText">
            Use the left panel to rename/delete tags globally, or filter notes by tag.
          </div>
        </div>
      );
    }
    if (view === 'settings') {
      return (
        <div className="panelScroll">
          <div className="panelSectionTitle">Settings</div>
          <div className="panelText">
            Use the left panel to export/import backups, view storage usage, and clear local data.
          </div>
        </div>
      );
    }
    return <NoteEditor />;
  };

  return (
    <div className="AppShell">
      <MobileTopBar />
      <div className="layout">
        <Sidebar />
        <main className="main" aria-label="Main content">
          <MainPanel />
        </main>
      </div>

      {modal?.type === 'import' ? <ImportModal /> : null}
      <RenameTagModal
        modal={modal}
        onClose={() => setModal(null)}
        onRename={(from, to) => renameTagGlobally(from, to)}
      />
      {renderModal()}

      {isSidebarOpen ? <button className="backdrop" aria-label="Close sidebar" onClick={() => setIsSidebarOpen(false)} /> : null}
    </div>
  );
}

// PUBLIC_INTERFACE
function RenameTagModal({ modal, onClose, onRename }) {
  /** Rename-tag modal implemented as a standalone component so hooks are not called conditionally. */
  const isOpen = modal?.type === 'renameTag';
  const from = isOpen ? modal.from : '';

  const [nextName, setNextName] = useState(from);

  // Keep input in sync when opening/closing or when selecting a different tag.
  useEffect(() => {
    setNextName(from);
  }, [from]);

  if (!isOpen) return null;

  return (
    <div className="modalOverlay" role="dialog" aria-modal="true" aria-label="Rename tag">
      <div className="modal">
        <div className="modalHeader">
          <div className="modalTitle">Rename tag</div>
          <button className="iconBtn" onClick={onClose} aria-label="Close">
            ✕
          </button>
        </div>
        <div className="modalBody">
          <div className="formRow">
            <label className="label">From</label>
            <div className="readonlyField">{from}</div>
          </div>
          <div className="formRow">
            <label className="label" htmlFor="renameTagTo">
              To
            </label>
            <input id="renameTagTo" className="input" value={nextName} onChange={(e) => setNextName(e.target.value)} />
          </div>
        </div>
        <div className="modalFooter">
          <button className="btn btnSecondary" onClick={onClose}>
            Cancel
          </button>
          <button
            className="btn"
            onClick={() => {
              onRename(from, nextName);
              onClose();
            }}
          >
            Rename
          </button>
        </div>
      </div>
    </div>
  );
}

// PUBLIC_INTERFACE
function TagInput({ onAdd, placeholder }) {
  /** Small controlled tag input that adds on Enter or comma. */
  const [value, setValue] = useState('');

  const commit = useCallback(() => {
    const parts = value
      .split(',')
      .map((p) => p.trim())
      .filter(Boolean);
    if (parts.length) {
      for (const p of parts) onAdd(p);
    }
    setValue('');
  }, [value, onAdd]);

  return (
    <div className="tagInputWrap">
      <input
        className="input"
        value={value}
        placeholder={placeholder}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ',') {
            e.preventDefault();
            commit();
          }
        }}
        aria-label="Add tag"
      />
      <button className="btn btnSmall btnSecondary" onClick={commit} aria-label="Add tag button">
        Add
      </button>
    </div>
  );
}

export default App;
