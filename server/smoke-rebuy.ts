/**
 * Rebuy smoke test: a human vs one AI heads-up with tiny stacks so busts happen
 * fast. Verifies that busting does NOT kick to the lobby and that rebuying lets
 * the player continue. Run with: tsx server/smoke-rebuy.ts
 */
import WebSocket from 'ws';
import { getLegalActions } from '../src/engine/game';
import type { ServerMsg, ClientMsg } from '../src/online/protocol';

const URL = process.env.URL ?? 'ws://localhost:8080/ws';

let sawPlaying = false;
let maxHand = 0;
let sawBust = false;
let rebought = false;
let wentToLobbyAfterStart = false;

const ws = new WebSocket(URL);
const send = (m: ClientMsg) => ws.readyState === ws.OPEN && ws.send(JSON.stringify(m));
ws.on('open', () => send({ t: 'hello', name: 'Alice' }));
ws.on('message', (raw) => {
  const msg = JSON.parse(raw.toString()) as ServerMsg;
  if (msg.t !== 'view') return;
  const view = msg.view;

  if (view.phase === 'lobby') {
    if (sawPlaying) {
      wentToLobbyAfterStart = true; // should never happen merely on a bust
      return;
    }
    // Configure small stacks BEFORE sitting so the human also gets a tiny stack.
    if (view.config.startingStackBB !== 2) return send({ t: 'config', config: { startingStackBB: 2, difficulty: 'easy' } });
    if (view.youSeatId === null) return send({ t: 'sit', seatId: 0 });
    if (view.seats[1]?.kind === 'empty') return send({ t: 'addAI', seatId: 1 });
    return send({ t: 'start' });
  }

  if (view.phase === 'playing' && view.game) {
    sawPlaying = true;
    maxHand = Math.max(maxHand, view.game.handNumber);
    const me = view.youSeatId !== null ? view.game.players[view.youSeatId] : null;

    // Busted between hands -> rebuy to continue.
    if (me && me.stack <= 0 && (view.handOver || me.sittingOut)) {
      sawBust = true;
      send({ t: 'rebuy' });
      rebought = true;
      return;
    }
    if (view.handOver) return send({ t: 'ready' });

    if (view.toActSeatId === view.youSeatId && view.youSeatId !== null) {
      const hi = view.game.players.findIndex((p) => p.isHero);
      const legal = getLegalActions(view.game, hi);
      send({ t: 'action', action: { type: 'allin', amount: legal.maxRaiseTo } });
    }
  }
});

setTimeout(() => {
  console.log(`maxHand=${maxHand} sawBust=${sawBust} rebought=${rebought} wentToLobby=${wentToLobbyAfterStart}`);
  if (maxHand >= 3 && sawBust && rebought && !wentToLobbyAfterStart) {
    console.log('REBUY_OK: busted, rebought and kept playing without being kicked to lobby');
    process.exit(0);
  }
  console.error('REBUY_FAIL');
  process.exit(1);
}, 13000);
