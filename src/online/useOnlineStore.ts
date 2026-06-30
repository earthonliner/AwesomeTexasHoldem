import { create } from 'zustand';
import type { PlayerAction } from '../engine/types';
import {
  type RoomView,
  type ServerMsg,
  type ClientMsg,
  type TableConfig,
  WS_PATH,
} from './protocol';

const TOKEN_KEY = 'texas-poker-online:token';

interface OnlineStore {
  status: 'idle' | 'connecting' | 'connected' | 'error';
  error: string | null;
  view: RoomView | null;
  name: string;
  url: string;

  connect: (name: string, url?: string) => void;
  disconnect: () => void;
  send: (msg: ClientMsg) => void;

  sit: (seatId: number) => void;
  stand: () => void;
  setConfig: (config: Partial<TableConfig>) => void;
  addAI: (seatId: number) => void;
  removeAI: (seatId: number) => void;
  start: () => void;
  act: (action: PlayerAction) => void;
  rebuy: () => void;
  ready: () => void;
  backToLobby: () => void;
}

let socket: WebSocket | null = null;

function defaultUrl(): string {
  if (typeof location === 'undefined') return `ws://localhost:8080${WS_PATH}`;
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  // Served by the LAN server -> same origin. In `vite dev`, fall back to :8080.
  const host = location.port === '5173' ? `${location.hostname}:8080` : location.host;
  return `${proto}://${host}${WS_PATH}`;
}

export const useOnlineStore = create<OnlineStore>((set, get) => ({
  status: 'idle',
  error: null,
  view: null,
  name: '',
  url: '',

  connect: (name, url) => {
    const target = url && url.trim() ? url.trim() : defaultUrl();
    set({ status: 'connecting', error: null, name, url: target });

    try {
      socket?.close();
    } catch {
      /* ignore */
    }

    const ws = new WebSocket(target);
    socket = ws;

    ws.onopen = () => {
      set({ status: 'connected' });
      const token = localStorage.getItem(TOKEN_KEY) ?? undefined;
      ws.send(JSON.stringify({ t: 'hello', name, token } satisfies ClientMsg));
    };

    ws.onmessage = (ev) => {
      let msg: ServerMsg;
      try {
        msg = JSON.parse(ev.data as string) as ServerMsg;
      } catch {
        return;
      }
      if (msg.t === 'welcome') {
        try {
          localStorage.setItem(TOKEN_KEY, msg.token);
        } catch {
          /* ignore */
        }
      } else if (msg.t === 'view') {
        set({ view: msg.view });
      } else if (msg.t === 'error') {
        set({ error: msg.message });
      }
    };

    ws.onerror = () => {
      set({ status: 'error', error: '无法连接到服务器，请检查地址与网络。' });
    };

    ws.onclose = () => {
      if (get().status !== 'error') set({ status: 'idle', view: null });
    };
  },

  disconnect: () => {
    try {
      socket?.close();
    } catch {
      /* ignore */
    }
    socket = null;
    set({ status: 'idle', view: null, error: null });
  },

  send: (msg) => {
    if (socket && socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(msg));
  },

  sit: (seatId) => get().send({ t: 'sit', seatId }),
  stand: () => get().send({ t: 'stand' }),
  setConfig: (config) => get().send({ t: 'config', config }),
  addAI: (seatId) => get().send({ t: 'addAI', seatId }),
  removeAI: (seatId) => get().send({ t: 'removeAI', seatId }),
  start: () => get().send({ t: 'start' }),
  act: (action) => get().send({ t: 'action', action }),
  rebuy: () => get().send({ t: 'rebuy' }),
  ready: () => get().send({ t: 'ready' }),
  backToLobby: () => get().send({ t: 'backToLobby' }),
}));
