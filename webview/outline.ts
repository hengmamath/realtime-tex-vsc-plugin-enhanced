import type { OutlineEntry, OutlineViewState } from '../src/outline';

export type { OutlineViewState } from '../src/outline';

interface OutlineHooks {
  /** Return false while a compiled destination is not available. */
  navigate(target: string): boolean;
  /** Apply geometry changes while preserving the current reading position. */
  layout(change: () => void): void;
  save(state: OutlineViewState): void;
}

interface OutlineNode {
  entry: OutlineEntry;
  parent?: OutlineNode;
  children: OutlineNode[];
  item: HTMLElement;
  group: HTMLElement;
  toggle: HTMLButtonElement;
  link: HTMLButtonElement;
}

const MIN_WIDTH = 200;
const MAX_WIDTH = 360;
const EMPTY_MESSAGE = 'No compiled outline yet. Section headings appear after a full compile.';

/** Compiled document navigation, kept separate from page rendering and reading history. */
export class OutlineSidebar {
  private readonly sidebar = this.element('outlineSidebar');
  private readonly toggle = this.element<HTMLButtonElement>('outlineToggle');
  private readonly closeButton = this.element<HTMLButtonElement>('outlineClose');
  private readonly tree = this.element('outlineTree');
  private readonly empty = this.element('outlineEmpty');
  private readonly resize = this.element('outlineResize');
  private readonly backdrop = this.element('outlineBackdrop');
  private readonly desktop = window.matchMedia('(min-width: 800px)');
  private state: OutlineViewState = { open: false, width: 240, collapsed: [] };
  private nodes = new Map<string, OutlineNode>();
  private roots: OutlineNode[] = [];
  private focused?: string;
  private active?: string;
  private renderedEntries?: OutlineEntry[];

  constructor(private readonly hooks: OutlineHooks) {
    this.tree.setAttribute('role', 'tree');
    this.tree.setAttribute('aria-label', 'Document contents');
    this.toggle.addEventListener('click', () => this.setOpen(!this.state.open));
    this.closeButton.addEventListener('click', () => this.close());
    this.backdrop.addEventListener('click', () => this.close());
    this.sidebar.addEventListener('keydown', (event) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      event.stopPropagation();
      this.close();
    });
    this.tree.addEventListener('keydown', (event) => this.keydown(event));
    this.desktop.addEventListener('change', () => {
      this.hooks.layout(() => this.syncGeometry());
    });
    this.installResize();
    this.syncGeometry();
  }

  private element<T extends HTMLElement = HTMLElement>(id: string): T {
    return document.getElementById(id) as T;
  }

  setDocument(entries: readonly OutlineEntry[], state?: OutlineViewState, message?: string): void {
    const old = this.state;
    const next = state ?? { open: false, width: 240, collapsed: [] };
    this.state = {
      open: next.open === true,
      width: this.clampWidth(next.width),
      collapsed: Array.isArray(next.collapsed) ? [...new Set(next.collapsed.filter((id) => typeof id === 'string'))] : [],
    };
    this.focused = undefined;
    this.active = undefined;
    // A different document can have identical headings but different collapsed preferences.
    this.renderedEntries = undefined;
    this.updateEntries(entries, message);
    if (old.open !== this.state.open || old.width !== this.state.width) this.hooks.layout(() => this.syncGeometry());
    else this.syncGeometry();
  }

  updateEntries(entries: readonly OutlineEntry[], message = EMPTY_MESSAGE): void {
    this.empty.textContent = message;
    // Live paragraph updates usually move pixels without changing the outline. Avoid
    // replacing a focused tree (and resetting its local reading position) on each edit.
    if (this.renderedEntries?.length === entries.length && entries.every((entry, index) => {
      const old = this.renderedEntries![index];
      return old.id === entry.id && old.title === entry.title && old.target === entry.target
        && old.level === entry.level && old.page === entry.page;
    })) return;
    this.renderedEntries = entries.map((entry) => ({ ...entry }));
    const oldFocus = this.focused;
    const hadFocus = this.tree.contains(document.activeElement);
    const scrollTop = this.tree.scrollTop;
    this.nodes.clear();
    this.roots = [];
    this.tree.replaceChildren();
    const stack: OutlineNode[] = [];
    const collapsed = new Set(this.state.collapsed);

    for (const entry of entries) {
      if (this.nodes.has(entry.id)) continue;
      while (stack.length && stack[stack.length - 1].entry.level >= entry.level) stack.pop();
      const parent = stack[stack.length - 1];
      const node = this.makeNode(entry, parent);
      this.nodes.set(entry.id, node);
      if (parent) {
        parent.children.push(node);
        parent.group.append(node.item);
      } else {
        this.roots.push(node);
        this.tree.append(node.item);
      }
      stack.push(node);
    }

    for (const node of this.nodes.values()) {
      const branch = node.children.length > 0;
      node.toggle.hidden = !branch;
      node.group.hidden = !branch || collapsed.has(node.entry.id);
      if (branch) {
        node.item.setAttribute('aria-expanded', String(!node.group.hidden));
        node.toggle.setAttribute('aria-label', `${node.group.hidden ? 'Expand' : 'Collapse'} ${node.entry.title}`);
      }
    }
    this.empty.hidden = entries.length !== 0;
    this.tree.hidden = entries.length === 0;
    this.focused = oldFocus && this.nodes.has(oldFocus) ? oldFocus : this.roots[0]?.entry.id;
    this.syncTabStops();
    this.setActive(this.active);
    this.tree.scrollTop = scrollTop;
    if (hadFocus) this.focusNode(this.nodes.get(this.focused ?? '') ?? this.roots[0]);
  }

  setActive(id: string | undefined): void {
    this.active = id;
    for (const node of this.nodes.values()) {
      const active = node.entry.id === id;
      node.item.classList.toggle('is-active', active);
      node.item.classList.remove('contains-active');
      node.item.setAttribute('aria-selected', String(active));
      if (active) node.link.setAttribute('aria-current', 'location');
      else node.link.removeAttribute('aria-current');
    }
    for (let parent = this.nodes.get(id ?? '')?.parent; parent; parent = parent.parent) {
      parent.item.classList.add('contains-active');
    }
  }

  getState(): OutlineViewState {
    return { ...this.state, collapsed: [...this.state.collapsed] };
  }

  close(): void {
    this.setOpen(false);
  }

  private makeNode(entry: OutlineEntry, parent?: OutlineNode): OutlineNode {
    const item = document.createElement('div');
    item.className = 'outline-item';
    item.dataset.id = entry.id;
    item.setAttribute('role', 'treeitem');
    item.setAttribute('aria-level', String((parent ? Number(parent.item.getAttribute('aria-level')) : 0) + 1));
    item.tabIndex = -1;
    const row = document.createElement('div');
    row.className = 'outline-row';
    const toggle = document.createElement('button');
    toggle.className = 'outline-expander';
    toggle.type = 'button';
    toggle.tabIndex = -1;
    toggle.dataset.outlineToggle = entry.id;
    toggle.innerHTML = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="m6 4 4 4-4 4" fill="none" stroke="currentColor" stroke-width="1.5"/></svg>';
    const link = document.createElement('button');
    link.className = 'outline-entry';
    link.type = 'button';
    link.tabIndex = -1;
    link.dataset.outlineEntry = entry.id;
    link.dataset.id = entry.id;
    const title = document.createElement('span');
    title.className = 'outline-title';
    title.textContent = entry.title || 'Untitled section';
    const page = document.createElement('span');
    page.className = 'outline-page';
    page.textContent = entry.page === undefined ? '' : String(entry.page);
    page.setAttribute('aria-hidden', 'true');
    link.title = entry.title;
    item.setAttribute('aria-label', `${entry.title}${entry.page === undefined ? '' : `, page ${entry.page}`}`);
    link.append(title, page);
    row.append(toggle, link);
    const group = document.createElement('div');
    group.className = 'outline-children';
    group.setAttribute('role', 'group');
    item.append(row, group);
    const node: OutlineNode = { entry, parent, children: [], item, group, toggle, link };
    toggle.addEventListener('click', (event) => {
      event.stopPropagation();
      this.focusNode(node);
      this.setExpanded(node, node.group.hidden);
    });
    link.addEventListener('click', (event) => {
      event.stopPropagation();
      this.focusNode(node);
      this.navigate(node);
    });
    item.addEventListener('focus', (event) => {
      if (event.target !== item) return;
      this.focused = entry.id;
      this.syncTabStops();
    });
    return node;
  }

  private navigate(node: OutlineNode): void {
    if (this.hooks.navigate(node.entry.target) && !this.desktop.matches) this.close();
  }

  private setOpen(open: boolean): void {
    if (this.state.open === open) return;
    this.hooks.layout(() => {
      this.state.open = open;
      this.syncGeometry();
    });
    this.hooks.save(this.getState());
    if (open) {
      const active = this.nodes.get(this.active ?? '');
      const visible = this.visibleNodes();
      this.focusNode(active && visible.includes(active) ? active : this.nodes.get(this.focused ?? '') ?? visible[0]);
      if (!visible.length) this.closeButton.focus();
    } else {
      this.toggle.focus();
    }
  }

  private syncGeometry(): void {
    document.documentElement.style.setProperty('--outline-width', `${this.state.width}px`);
    document.body.classList.toggle('outline-open', this.state.open);
    this.sidebar.hidden = !this.state.open;
    this.backdrop.hidden = !this.state.open || this.desktop.matches;
    this.toggle.classList.toggle('active', this.state.open);
    this.toggle.setAttribute('aria-expanded', String(this.state.open));
    this.toggle.title = this.state.open ? 'Hide contents' : 'Show contents';
    this.toggle.setAttribute('aria-label', this.toggle.title);
    this.resize.setAttribute('aria-valuenow', String(this.state.width));
    this.resize.tabIndex = this.desktop.matches ? 0 : -1;
  }

  private setExpanded(node: OutlineNode, expanded: boolean): void {
    if (!node.children.length) return;
    const collapsed = new Set(this.state.collapsed);
    if (expanded) collapsed.delete(node.entry.id);
    else collapsed.add(node.entry.id);
    this.state.collapsed = [...collapsed];
    node.group.hidden = !expanded;
    node.item.setAttribute('aria-expanded', String(expanded));
    node.toggle.setAttribute('aria-label', `${expanded ? 'Collapse' : 'Expand'} ${node.entry.title}`);
    this.syncTabStops();
    this.hooks.save(this.getState());
  }

  private visibleNodes(): OutlineNode[] {
    const visible: OutlineNode[] = [];
    const visit = (nodes: OutlineNode[]) => {
      for (const node of nodes) {
        visible.push(node);
        if (!node.group.hidden) visit(node.children);
      }
    };
    visit(this.roots);
    return visible;
  }

  private syncTabStops(): void {
    const visible = this.visibleNodes();
    if (!visible.some((node) => node.entry.id === this.focused)) this.focused = visible[0]?.entry.id;
    for (const node of this.nodes.values()) node.item.tabIndex = node.entry.id === this.focused ? 0 : -1;
  }

  private focusNode(node: OutlineNode | undefined): void {
    if (!node) return;
    this.focused = node.entry.id;
    this.syncTabStops();
    node.item.focus({ preventScroll: true });
    node.item.querySelector('.outline-row')?.scrollIntoView({ block: 'nearest' });
  }

  private keydown(event: KeyboardEvent): void {
    if (event.altKey || event.ctrlKey || event.metaKey) return;
    const node = this.nodes.get((event.target as HTMLElement).closest<HTMLElement>('[role="treeitem"]')?.dataset.id ?? '');
    if (!node) return;
    const visible = this.visibleNodes();
    const index = visible.indexOf(node);
    switch (event.key) {
      case 'ArrowDown': this.focusNode(visible[Math.min(index + 1, visible.length - 1)]); break;
      case 'ArrowUp': this.focusNode(visible[Math.max(index - 1, 0)]); break;
      case 'Home': this.focusNode(visible[0]); break;
      case 'End': this.focusNode(visible[visible.length - 1]); break;
      case 'ArrowRight':
        if (node.children.length && node.group.hidden) this.setExpanded(node, true);
        else this.focusNode(node.children[0]);
        break;
      case 'ArrowLeft':
        if (node.children.length && !node.group.hidden) this.setExpanded(node, false);
        else this.focusNode(node.parent);
        break;
      case 'Enter': case ' ': this.navigate(node); break;
      default: return;
    }
    event.preventDefault();
    event.stopPropagation();
  }

  private clampWidth(width: number): number {
    return Number.isFinite(width) ? Math.round(Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, width))) : 240;
  }

  private setWidth(width: number): void {
    const next = this.clampWidth(width);
    if (this.state.width === next) return;
    this.hooks.layout(() => {
      this.state.width = next;
      this.syncGeometry();
    });
  }

  private installResize(): void {
    this.resize.setAttribute('role', 'separator');
    this.resize.setAttribute('aria-label', 'Resize contents');
    this.resize.setAttribute('aria-orientation', 'vertical');
    this.resize.setAttribute('aria-valuemin', String(MIN_WIDTH));
    this.resize.setAttribute('aria-valuemax', String(MAX_WIDTH));
    let pointer: number | undefined;
    let frame: number | undefined;
    let pendingWidth = this.state.width;
    const flush = () => {
      if (frame !== undefined) cancelAnimationFrame(frame);
      frame = undefined;
      this.setWidth(pendingWidth);
    };
    this.resize.addEventListener('pointerdown', (event) => {
      if (!this.desktop.matches || event.button !== 0) return;
      pointer = event.pointerId;
      pendingWidth = this.state.width;
      this.resize.setPointerCapture(pointer);
      document.body.classList.add('outline-resizing');
      event.preventDefault();
    });
    this.resize.addEventListener('pointermove', (event) => {
      if (event.pointerId !== pointer) return;
      pendingWidth = event.clientX;
      if (frame === undefined) frame = requestAnimationFrame(flush);
    });
    const finish = (event: PointerEvent) => {
      if (event.pointerId !== pointer) return;
      flush();
      pointer = undefined;
      document.body.classList.remove('outline-resizing');
      this.hooks.save(this.getState());
    };
    this.resize.addEventListener('pointerup', finish);
    this.resize.addEventListener('pointercancel', finish);
    this.resize.addEventListener('lostpointercapture', finish);
    this.resize.addEventListener('keydown', (event) => {
      let width: number;
      switch (event.key) {
        case 'ArrowLeft': width = this.state.width - 10; break;
        case 'ArrowRight': width = this.state.width + 10; break;
        case 'Home': width = MIN_WIDTH; break;
        case 'End': width = MAX_WIDTH; break;
        default: return;
      }
      event.preventDefault();
      event.stopPropagation();
      this.setWidth(width);
      this.hooks.save(this.getState());
    });
  }
}
