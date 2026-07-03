/**
 * Rebuy smoke test: two humans heads-up with tiny stacks, both shove every hand
 * so one busts deterministically. Verifies a busted human can rebuy AND ready up
 * to keep playing, and the table never gets stuck or kicked to the lobby.
 * Run with: tsx server/smoke-rebuy.ts
 */
import WebSocket from 'ws';
import { getLegalActions } from '../src/engine/game';
import type { ServerMsg, ClientMsg, RoomView } from '../src/online/protocol';

const URL = process.env.URL ?? 'ws://localhost:8080/ws';

let sawPlaying = false;
let maxHand = 0;
let sawBust = false;
let rebought = false;
let wentToLobbyAfterStart = false;

function makeClient(seatId: number, isHost: boolean) {
  const ws = new WebSocket(URL);
  const send = (m: ClientMsg) => ws.readyState === ws.OPEN && ws.send(JSON.stringify(m));
  ws.on('open', () => send({ t: 'hello', name: seatId === 0 ? 'Alice' : 'Bob' }));
  ws.on('message', (raw) => {
    const msg = JSON.parse(raw.toString()) as ServerMsg;
    if (msg.t !== 'view') return;
    const view = msg.view as RoomView;

    if (view.phase === 'lobby') {
      if (sawPlaying) {
        wentToLobbyAfterStart = true;
        return;
      }
      if (isHost && view.config.startingStackBB !== 2) return send({ t: 'config', config: { startingStackBB: 2 } });
      if (view.youSeatId === null) return send({ t: 'sit', seatId });
      if (isHost) {
        const bothSeated = view.seats.filter((s) => s.kind === 'human').length >= 2;
        if (bothSeated) return send({ t: 'start' });
      }
      return;
    }

    if (view.phase === 'playing' && view.game && view.youSeatId !== null) {
      sawPlaying = true;
      maxHand = Math.max(maxHand, view.game.handNumber);
      const seatStack = view.seats.find((s) => s.seatId === view.youSeatId)?.stack ?? 0;
      const me = view.game.players[view.youSeatId];

      // Out of chips between hands -> rebuy, then ready.
      if (seatStack <= 0 && (view.handOver || me.sittingOut)) {
        sawBust = true;
        rebought = true;
        return send({ t: 'rebuy' });
      }
      if (view.handOver) return send({ t: 'ready' });
      if (view.toActSeatId === view.youSeatId) {
        const legal = getLegalActions(view.game, view.youSeatId);
        return send({ t: 'action', action: { type: 'allin', amount: legal.maxRaiseTo } });
      }
    }
  });
  return ws;
}

makeClient(0, true);
setTimeout(() => makeClient(1, false), 500);

setTimeout(() => {
  console.log(`maxHand=${maxHand} sawBust=${sawBust} rebought=${rebought} wentToLobby=${wentToLobbyAfterStart}`);
  if (maxHand >= 3 && sawBust && rebought && !wentToLobbyAfterStart) {
    console.log('REBUY_OK: busted human rebought, readied and kept playing');
    process.exit(0);
  }
  console.error('REBUY_FAIL');
  process.exit(1);
}, 14000);
