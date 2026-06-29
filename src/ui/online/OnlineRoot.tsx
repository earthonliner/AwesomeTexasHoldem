import { useOnlineStore } from '../../online/useOnlineStore';
import { ConnectScreen } from './ConnectScreen';
import { Lobby } from './Lobby';
import { OnlineGameView } from './OnlineGameView';

export function OnlineRoot({ onExit }: { onExit: () => void }) {
  const status = useOnlineStore((s) => s.status);
  const view = useOnlineStore((s) => s.view);
  const disconnect = useOnlineStore((s) => s.disconnect);

  const leave = () => {
    disconnect();
    onExit();
  };

  if (status !== 'connected' || !view) {
    return <ConnectScreen onBack={onExit} />;
  }

  if (view.phase === 'lobby' || !view.game) {
    return <Lobby view={view} onExit={leave} />;
  }

  return <OnlineGameView view={view} onExit={leave} />;
}
