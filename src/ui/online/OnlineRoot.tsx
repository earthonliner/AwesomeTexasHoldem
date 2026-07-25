import { useEffect } from 'react';
import { useOnlineStore } from '../../online/useOnlineStore';
import { useGameStore } from '../../store/useGameStore';
import { setDisplayBlindLevel } from '../../utils/format';
import { ConnectScreen } from './ConnectScreen';
import { Lobby } from './Lobby';
import { OnlineGameView } from './OnlineGameView';

export function OnlineRoot({ onExit }: { onExit: () => void }) {
  const status = useOnlineStore((s) => s.status);
  const view = useOnlineStore((s) => s.view);
  const disconnect = useOnlineStore((s) => s.disconnect);
  const localBlindLevel = useGameStore((s) => s.settings.blindLevel);

  // Money display follows the table's blind level while online; restore the
  // local setting when leaving.
  const onlineBlindLevel = view?.config.blindLevel;
  useEffect(() => {
    setDisplayBlindLevel(onlineBlindLevel ?? localBlindLevel);
    return () => setDisplayBlindLevel(localBlindLevel);
  }, [onlineBlindLevel, localBlindLevel]);

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
