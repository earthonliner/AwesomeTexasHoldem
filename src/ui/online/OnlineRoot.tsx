import { useEffect } from 'react';
import { useOnlineStore } from '../../online/useOnlineStore';
import { useGameStore } from '../../store/useGameStore';
import { setDisplayBlindLevel, setDisplayChipRatio } from '../../utils/format';
import { ConnectScreen } from './ConnectScreen';
import { Lobby } from './Lobby';
import { OnlineGameView } from './OnlineGameView';

export function OnlineRoot({ onExit }: { onExit: () => void }) {
  const status = useOnlineStore((s) => s.status);
  const view = useOnlineStore((s) => s.view);
  const disconnect = useOnlineStore((s) => s.disconnect);
  const localBlindLevel = useGameStore((s) => s.settings.blindLevel);
  const localChipRatio = useGameStore((s) => s.settings.chipRatio ?? 1);

  // Money display follows the TABLE's blind level and chip ratio while online,
  // so every player at the table sees identical amounts; restore the local
  // settings when leaving.
  const onlineBlindLevel = view?.config.blindLevel;
  const onlineChipRatio = view?.config.chipRatio;
  useEffect(() => {
    setDisplayBlindLevel(onlineBlindLevel ?? localBlindLevel);
    setDisplayChipRatio(onlineChipRatio ?? localChipRatio);
    return () => {
      setDisplayBlindLevel(localBlindLevel);
      setDisplayChipRatio(localChipRatio);
    };
  }, [onlineBlindLevel, localBlindLevel, onlineChipRatio, localChipRatio]);

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
