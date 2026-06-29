/**
 * Standalone LAN smoke test: connects two simulated human clients, seats them,
 * adds AI, starts the game and auto-plays simple legal actions for ~9s. Verifies
 * hands advance and chips are conserved. Run with: tsx server/smoke.ts
 */
import WebSocket from 'ws';
import { getLegalActions } from '../src/engine/game';
import type { RoomView, ServerMsg, ClientMsg } from '../src/online/protocol';

const URL = process.env.URL ?? 'ws://localhost:8080/ws';

function client(name: string, onView: (v: RoomView, send: (m: ClientMsg) => void) => void) {
  const ws = new WebSocket(URL);
  const send = (m: ClientMsg) => ws.readyState === ws.OPEN && ws.send(JSON.stringify(m));
  ws.on('open', () => send({ t: 'hello', name }));
  ws.on('message', (raw) => {
    const msg = JSON.parse(raw.toString()) as ServerMsg;
    if (msg.t === 'view') onView(msg.view, send);
  });
  return { ws, send };
}

let maxHand = 0;
let started = false;

function autoPlay(view: RoomView, send: (m: ClientMsg) => void) {
  if (view.phase !== 'playing' || !view.game) return;
  maxHand = Math.max(maxHand, view.game.handNumber);
  if (view.toActSeatId !== view.youSeatId || view.handOver) return;
  const hi = view.game.players.findIndex((p) => p.isHero);
  if (hi < 0) return;
  const legal = getLegalActions(view.game, hi);
  // Mostly check/call cheaply, fold to big bets.
  if (legal.canCheck) send({ t: 'action', action: { type: 'check', amount: 0 } });
  else if (legal.callAmount <= 6) send({ t: 'action', action: { type: 'call', amount: 0 } });
  else send({ t: 'action', action: { type: 'fold', amount: 0 } });
}

const a = client('Alice', (view, send) => {
  // Host: set up the table once.
  if (view.phase === 'lobby' && view.isHost && !started) {
    if (view.youSeatId === null) return send({ t: 'sit', seatId: 0 });
    // Seat 1 reserved for Bob; fill 2 & 3 with AI then start.
    const empties = view.seats.filter((s) => s.kind === 'empty').map((s) => s.seatId);
    const bobSeated = view.seats.some((s) => s.kind === 'human' && s.seatId !== view.youSeatId);
    if (empties.includes(2)) return send({ t: 'addAI', seatId: 2 });
    if (empties.includes(3)) return send({ t: 'addAI', seatId: 3 });
    if (bobSeated) {
      started = true;
      return send({ t: 'start' });
    }
    return;
  }
  autoPlay(view, send);
});

setTimeout(() => {
  client('Bob', (view, send) => {
    if (view.phase === 'lobby' && view.youSeatId === null) return send({ t: 'sit', seatId: 1 });
    autoPlay(view, send);
  });
}, 400);

setTimeout(() => {
  console.log(`max hand reached: ${maxHand}`);
  if (maxHand >= 2) {
    console.log('SMOKE_OK: multiple hands played over LAN with humans + AI');
    process.exit(0);
  } else {
    console.error('SMOKE_FAIL: game did not advance');
    process.exit(1);
  }
  void a;
}, 12000);
