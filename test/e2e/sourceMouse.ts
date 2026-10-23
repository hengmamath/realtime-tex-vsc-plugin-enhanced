// Test-only Chromium input drives the real editor and context menu, not extension callbacks.
export async function sourceMouse() {
  const port = process.env.RTEX_E2E_CDP_PORT;
  if (!port) throw new Error('The E2E runner must enable its isolated Chromium debugging port');
  const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json() as { type: string; url: string; webSocketDebuggerUrl: string }[];
  const target = targets.find(t => t.type === 'page' && t.url.includes('workbench'));
  if (!target) throw new Error('VS Code workbench debugging target missing');
  interface Socket {
    addEventListener(type: string, listener: (event: { data?: unknown }) => void): void;
    send(value: string): void;
    close(): void;
  }
  const WebSocket = (globalThis as unknown as { WebSocket: new (url: string) => Socket }).WebSocket;
  const socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise<void>((resolve, reject) => {
    socket.addEventListener('open', () => resolve());
    socket.addEventListener('error', () => reject(new Error('Cannot connect to VS Code input driver')));
  });
  let next = 0;
  const pending = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void }>();
  socket.addEventListener('message', event => {
    const message = JSON.parse(String(event.data));
    const call = pending.get(message.id);
    if (!call) return;
    pending.delete(message.id);
    if (message.error) call.reject(new Error(JSON.stringify(message.error)));
    else call.resolve(message.result);
  });
  socket.addEventListener('close', () => {
    for (const call of pending.values()) call.reject(new Error('VS Code input driver closed'));
    pending.clear();
  });
  const send = (method: string, params: object = {}): Promise<any> => new Promise((resolve, reject) => {
    const id = ++next;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`Timed out: ${method}`)); }, 10000);
    pending.set(id, { resolve: value => { clearTimeout(timer); resolve(value); }, reject: error => { clearTimeout(timer); reject(error); } });
    socket.send(JSON.stringify({ id, method, params }));
  });
  const evaluate = async (expression: string) => {
    const result = await send('Runtime.evaluate', { expression, returnByValue: true });
    if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
    return result.result.value;
  };
  const click = async (point: { x: number; y: number }, button = 'left', clickCount = 1) => {
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', ...point, button, clickCount });
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...point, button, clickCount });
  };
  await send('Page.bringToFront');
  return {
    close: () => socket.close(),
    focus: () => send('Page.bringToFront'),
    screenshot: async () => (await send('Page.captureScreenshot', { format: 'png' })).data as string,
    async at(source: string, line: number, column: number, mode: 'double' | 'context') {
      await send('Page.bringToFront');
      const point = await evaluate(`(() => {
        const source = ${JSON.stringify(source)};
        const rows = [...document.querySelectorAll('.monaco-editor .view-lines .view-line')];
        const number = [...document.querySelectorAll('.monaco-editor .line-numbers')].find(e => e.textContent === '${line + 1}');
        const row = rows.find(r => number && Math.abs(r.getBoundingClientRect().y - number.getBoundingClientRect().y) < 1
          && r.textContent.replace(/\\u00a0/g, ' ').replace(/\\u200b/g, '') === source);
        if (!row) throw new Error('Visible source row missing: ' + source);
        const walker = document.createTreeWalker(row, NodeFilter.SHOW_TEXT);
        let offset = ${column}, node;
        while (node = walker.nextNode()) {
          if (offset < node.textContent.length) {
            const range = document.createRange(); range.setStart(node, offset); range.setEnd(node, offset + 1);
            // Hit the character's left half; its right edge can resolve to the empty caret after the line.
            const r = range.getBoundingClientRect(); return {x:r.x + r.width / 4, y:r.y + r.height / 2};
          }
          offset -= node.textContent.length;
        }
        throw new Error('Source column missing');
      })()`);
      if (mode === 'double') {
        await click(point);
        await click(point, 'left', 2);
      } else {
        await click(point, 'right');
        // Let the opening gesture and menu placement settle before measuring the item.
        await new Promise(resolve => setTimeout(resolve, 200));
        let menu;
        for (let i = 0; i < 30 && !menu; i++) {
          menu = await evaluate(`(() => {
            const roots = [document];
            for (let i = 0; i < roots.length; i++) for (const node of roots[i].querySelectorAll('*')) if (node.shadowRoot) roots.push(node.shadowRoot);
            const label = roots.flatMap(root => [...root.querySelectorAll('.monaco-menu .action-label')]).find(e => e.textContent.includes('Show Cursor Position in Preview'));
            if (!label) return null;
            const r = label.getBoundingClientRect(); return {x:r.x+r.width/2,y:r.y+r.height/2};
          })()`);
          if (!menu) await new Promise(resolve => setTimeout(resolve, 50));
        }
        if (!menu) throw new Error(`Show Cursor Position in Preview menu missing at ${line + 1}:${column} (${source}): `
          + await evaluate(`document.querySelector('.context-view')?.textContent`));
        await send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...menu });
        await click(menu);
      }
    },
  };
}
