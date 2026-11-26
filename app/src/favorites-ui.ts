// Phone-side favorites editor: search contacts, add, reorder (▲), remove (✕). Saves to the Mac on every change.
import type { Contact, Favorite, GatewayApi } from './types';

export const MAX_FAVORITES = 15;
export const MAX_RESULTS = 8; // keeps the list short enough to see above the keyboard
const SEARCH_DEBOUNCE_MS = 250;
const KEYBOARD_SETTLE_MS = 300; // let iOS finish its own keyboard scroll first

/** Pure list operations (unit-tested). */
export const favOps = {
  add: (items: readonly string[], name: string): string[] =>
    items.includes(name) || items.length >= MAX_FAVORITES ? [...items] : [...items, name],
  remove: (items: readonly string[], index: number): string[] => items.filter((_, i) => i !== index),
  moveUp: (items: readonly string[], index: number): string[] => {
    if (index <= 0 || index >= items.length) return [...items];
    const next = [...items];
    [next[index - 1], next[index]] = [next[index], next[index - 1]];
    return next;
  },
  /** Search hits worth showing: not already a favorite, one row per name, capped. */
  results: (found: readonly Contact[], items: readonly string[]): Contact[] => {
    const seen = new Set(items.map((n) => n.toLowerCase()));
    return found.filter((c) => {
      const key = c.name.toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    }).slice(0, MAX_RESULTS);
  },
};

function button(label: string, title: string, onClick: () => void): HTMLButtonElement {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'mini';
  b.textContent = label;
  b.title = title;
  b.setAttribute('aria-label', title);
  b.addEventListener('click', onClick);
  return b;
}

export interface FavoritesEditor {
  setApi(api: GatewayApi | null): void;
}

export function mountFavoritesEditor(log: (m: string) => void): FavoritesEditor {
  const section = document.getElementById('favorites') as HTMLElement;
  const list = document.getElementById('fav-list') as HTMLOListElement;
  const search = document.getElementById('fav-search') as HTMLInputElement;
  const results = document.getElementById('fav-results') as HTMLUListElement;
  const note = document.getElementById('fav-note') as HTMLParagraphElement;
  let api: GatewayApi | null = null;
  let items: string[] = [];
  let timer: number | undefined;

  const setNote = (text: string) => { note.textContent = text; };

  async function save(next: string[]): Promise<void> {
    if (!api) return;
    const previous = items;
    items = next;
    render();
    try {
      const saved = await api.setFavorites(next);
      items = saved.map((f: Favorite) => f.name);
      setNote(items.length >= MAX_FAVORITES ? `Maximum of ${MAX_FAVORITES} favorites.` : 'Saved.');
    } catch (err) {
      items = previous; // roll back so the list shows what the Mac actually has
      setNote(`Could not save: ${err instanceof Error ? err.message : 'error'}`);
      log('favorites save failed');
    }
    render();
  }

  function render(): void {
    list.replaceChildren(...items.map((name, i) => {
      const li = document.createElement('li');
      const label = document.createElement('span');
      label.textContent = name;
      li.append(label, button('▲', `Move ${name} up`, () => void save(favOps.moveUp(items, i))),
        button('✕', `Remove ${name}`, () => void save(favOps.remove(items, i))));
      return li;
    }));
    if (!items.length) {
      const li = document.createElement('li');
      li.className = 'empty';
      li.textContent = 'No favorites yet. Search below to add people.';
      list.append(li);
    }
  }

  function showResults(found: Contact[]): void {
    const shown = favOps.results(found, items);
    setNote(shown.length ? '' : 'No matching contacts.');
    results.replaceChildren(...shown.map((c) => {
      const li = document.createElement('li');
      const add = button(`+ ${c.name}`, `Add ${c.name} to favorites`, () => {
        search.value = '';
        search.blur();
        results.replaceChildren();
        void save(favOps.add(items, c.name));
      });
      add.className = 'result';
      li.append(add);
      return li;
    }));
    if (document.activeElement === search) pinSearch();
  }

  // iOS only scrolls a focused field just above the keyboard, which hides the results; pin the field to the top
  // instead, and drop the keyboard as soon as the user starts scrolling the results or taps Search.
  const pinSearch = () => search.scrollIntoView({ block: 'start', behavior: 'smooth' });
  search.addEventListener('focus', () => { window.setTimeout(pinSearch, KEYBOARD_SETTLE_MS); });
  search.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); search.blur(); } });
  results.addEventListener('touchstart', () => search.blur(), { passive: true });

  search.addEventListener('input', () => {
    window.clearTimeout(timer);
    const q = search.value.trim();
    if (!q || !api) { results.replaceChildren(); return; }
    timer = window.setTimeout(async () => {
      try {
        showResults(await api!.contacts(q));
      } catch {
        setNote('Contact search failed.');
      }
    }, SEARCH_DEBOUNCE_MS);
  });

  return {
    setApi(next) {
      api = next;
      section.hidden = !next;
      if (!next) return;
      setNote('');
      next.favorites().then((favs) => { items = favs.map((f) => f.name); render(); })
        .catch(() => setNote('Could not load favorites.'));
    },
  };
}
