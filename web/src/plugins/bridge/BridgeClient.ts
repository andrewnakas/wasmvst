import { BRIDGE_URL, type BridgePluginInfo, type CreatedInstance } from './protocol';

export type BridgeStatus = 'disconnected' | 'connecting' | 'connected';

interface Pending { resolve: (v: any) => void; reject: (e: Error) => void }

/**
 * Control connection to the native wasmvst-bridge helper. Reconnects in the
 * background so the bridge can be launched after the page is opened.
 */
export class BridgeClient extends EventTarget {
  status: BridgeStatus = 'disconnected';
  info: { version?: string; platform?: string } = {};
  plugins: BridgePluginInfo[] = [];
  private ws: WebSocket | null = null;
  private nextId = 1;
  private pending = new Map<number, Pending>();
  private retryTimer = 0;

  constructor(readonly url = BRIDGE_URL) {
    super();
  }

  connect() {
    if (this.ws) return;
    clearTimeout(this.retryTimer);
    this.setStatus('connecting');
    const ws = new WebSocket(`${this.url}/control`);
    this.ws = ws;
    ws.onopen = async () => {
      try {
        this.info = await this.request('hello', { client: 'wasmvst-web' });
        this.setStatus('connected');
        await this.refreshPlugins();
      } catch (e) {
        console.warn('bridge hello failed', e);
      }
    };
    ws.onmessage = (e) => this.onMessage(String(e.data));
    ws.onclose = () => {
      this.ws = null;
      for (const p of this.pending.values()) p.reject(new Error('bridge disconnected'));
      this.pending.clear();
      this.setStatus('disconnected');
      this.retryTimer = window.setTimeout(() => this.connect(), 3000);
    };
  }

  private setStatus(s: BridgeStatus) {
    this.status = s;
    this.dispatchEvent(new Event('status'));
  }

  private onMessage(text: string) {
    let msg: any;
    try { msg = JSON.parse(text); } catch { return; }
    if (typeof msg.re === 'number') {
      const p = this.pending.get(msg.re);
      if (!p) return;
      this.pending.delete(msg.re);
      if (msg.ok) p.resolve(msg);
      else p.reject(new Error(msg.error ?? 'bridge error'));
    } else if (msg.event) {
      if (msg.event === 'pluginsChanged') this.refreshPlugins();
      this.dispatchEvent(new CustomEvent(msg.event, { detail: msg }));
    }
  }

  request<T = any>(type: string, args: Record<string, unknown> = {}, timeoutMs = 60000): Promise<T> {
    const ws = this.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) return Promise.reject(new Error('bridge not connected'));
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`bridge ${type} timed out`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (v) => { clearTimeout(timer); resolve(v); },
        reject: (e) => { clearTimeout(timer); reject(e); },
      });
      ws.send(JSON.stringify({ id, type, ...args }));
    });
  }

  async refreshPlugins() {
    const r = await this.request<{ plugins: BridgePluginInfo[] }>('list');
    this.plugins = r.plugins;
    this.dispatchEvent(new Event('plugins'));
  }

  async rescan() {
    // Scanning many plugins can take minutes; progress arrives as events.
    await this.request('scan', {}, 15 * 60000);
    await this.refreshPlugins();
  }

  create(pluginId: string, sampleRate: number, blockSize: number): Promise<CreatedInstance> {
    return this.request('create', { pluginId, sampleRate, blockSize });
  }
}

export const bridge = new BridgeClient();
