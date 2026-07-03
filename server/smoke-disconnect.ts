/**
 * Disconnect-recovery smoke test: two humans start heads-up, then one disconnects
 * mid-game. The host returns to lobby, fills the freed seat with an AI, and
 * starts again. Verifies play resumes (the table isn't stuck on a ghost seat).
 * Run with: tsx server/smoke-disconnect.ts
 */
import WebSocket from 'ws';
import { getLegalActions } from '../src/engine/game';
import type { ServerMsg, ClientMsg, RoomView } from '../src/online/protocol';

const URL = process.env.URL ?? 'ws://localhost:8080/ws';

let stage: 'setup' | 'play1' | 'recover' | 'play2' = 'setup';
let handsAfterRestart = 0;
let bobDisconnected = false;
let resumed = false;

function autoAct(view: RoomView, send: (m: ClientMsg) => void) {
  if (!view.game || view.youSeatId === null) return;
  if (view.handOver) return send({ t: 'ready' });
  if (view.toActSeatId === view.youSeatId) {
    const legal = getLegalActions(view.game, view.youSeatId);
    send(legal.canCheck ? { t: 'action', action: { type: 'check', amount: 0 } } : { t: 'action', action: { type: 'call', amount: 0 } });
  }
}

// Host: Alice.
const aws = new WebSocket(URL);
const asend = (m: ClientMsg) => aws.readyState === aws.OPEN && aws.send(JSON.stringify(m));
aws.on('open', () => asend({ t: 'hello', name: 'Alice' }));
aws.on('message', (raw) => {
  const msg = JSON.parse(raw.toString()) as ServerMsg;
  if (msg.t !== 'view') return;
  const view = msg.view as RoomView;

  if (view.phase === 'lobby') {
    if (stage === 'setup') {
      if (view.youSeatId === null) return asend({ t: 'sit', seatId: 0 });
      const bob = view.seats.some((s) => s.kind === 'human' && s.seatId === 1);
      if (bob) {
        stage = 'play1';
        return asend({ t: 'start' });
      }
      return;
    }
    if (stage === 'recover') {
      // Seat 1 should now be free (ghost vacated). Fill with AI and restart.
      if (view.seats[1]?.kind === 'empty') return asend({ t: 'addAI', seatId: 1 });
      const active = view.seats.filter((s) => (s.kind === 'ai' || (s.kind === 'human' && s.connected)) && s.stack > 0).length;
      if (active >= 2) {
        stage = 'play2';
        resumed = true;
        return asend({ t: 'start' });
      }
      return;
    }
    return;
  }

  if (view.phase === 'playing') {
    if (stage === 'play1') {
      // Once Bob has dropped, go back to lobby to reform the table.
      const bobSeat = view.seats[1];
      if (bobDisconnected && bobSeat && (bobSeat.kind === 'empty' || !bobSeat.connected)) {
        stage = 'recover';
        return asend({ t: 'backToLobby' });
      }
      autoAct(view, asend);
      return;
    }
    if (stage === 'play2') {
      if (view.game) handsAfterRestart = Math.max(handsAfterRestart, view.game.handNumber);
      autoAct(view, asend);
    }
  }
});

// Player 2: Bob, disconnects shortly after play starts.
let bws: WebSocket | null = null;
setTimeout(() => {
  bws = new WebSocket(URL);
  const bsend = (m: ClientMsg) => bws && bws.readyState === bws.OPEN && bws.send(JSON.stringify(m));
  bws.on('open', () => bsend({ t: 'hello', name: 'Bob' }));
  bws.on('message', (raw) => {
    const msg = JSON.parse(raw.toString()) as ServerMsg;
    if (msg.t !== 'view') return;
    const view = msg.view as RoomView;
    if (view.phase === 'lobby' && view.youSeatId === null) return bsend({ t: 'sit', seatId: 1 });
    if (view.phase === 'playing' && !bobDisconnected) {
      // Drop mid-game.
      bobDisconnected = true;
      setTimeout(() => bws?.close(), 200);
    }
  });
}, 500);

setTimeout(() => {
  console.log(`stage=${stage} resumed=${resumed} handsAfterRestart=${handsAfterRestart}`);
  if (resumed && handsAfterRestart >= 2) {
    console.log('DISCONNECT_OK: table reformed and play resumed after a disconnect');
    process.exit(0);
  }
  console.error('DISCONNECT_FAIL');
  process.exit(1);
}, 16000);
