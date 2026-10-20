import type { ConnectionStatus } from '../state/useCeleste';
import { Icon } from './Icon';

export interface StatusBarProps {
  connection: ConnectionStatus;
  connectionError: string | null;
  providerLabel: string | null;
  model: string | null;
  extensionConnected: boolean;
  runningTasks: number;
  demoMode: boolean;
  onToggleDemo: () => void;
  onReconnect: () => void;
  version?: string | undefined;
}

const CONNECTION_COPY: Record<ConnectionStatus, string> = {
  connecting: 'Connecting',
  connected: 'Daemon connected',
  demo: 'Demo mode',
  offline: 'Offline',
};

/**
 * The bottom status bar.
 */
export function StatusBar({
  connection,
  connectionError,
  providerLabel,
  model,
  extensionConnected,
  runningTasks,
  demoMode,
  onToggleDemo,
  onReconnect,
  version,
}: StatusBarProps) {
  return (
    <footer className="statusbar">
      <button
        type="button"
        className={`statusbar__item statusbar__item--${connection}`}
        onClick={onReconnect}
        title={connectionError ?? 'Click to reconnect to the daemon'}
      >
        <span className="statusbar__dot" />
        <span>{CONNECTION_COPY[connection]}</span>
      </button>

      <span className="statusbar__sep" />

      <span className="statusbar__item" title="Active provider and model">
        <Icon name="sparkle" size={12} />
        <span className="statusbar__label">
          {providerLabel ?? 'No provider'}
          {model ? <span className="statusbar__muted"> · {model}</span> : null}
        </span>
      </span>

      <span className="statusbar__sep" />

      <span
        className={`statusbar__item${extensionConnected ? ' statusbar__item--ok' : ' statusbar__item--warn'}`}
        title={
          extensionConnected
            ? 'Browser extension bridge is connected'
            : 'Browser extension bridge is offline'
        }
      >
        <Icon name={extensionConnected ? 'wifi' : 'wifi-off'} size={12} />
        <span>{extensionConnected ? 'Extension connected' : 'Extension offline'}</span>
      </span>

      <span className="statusbar__sep" />

      <span className="statusbar__item" title="Tasks currently running">
        <Icon name="zap" size={12} />
        <span>
          {runningTasks} running
        </span>
      </span>

      <span className="statusbar__spacer" />

      <button
        type="button"
        className={`statusbar__item statusbar__item--button${demoMode ? ' statusbar__item--demo' : ''}`}
        onClick={onToggleDemo}
        title="Toggle the built-in demo daemon"
      >
        <Icon name="terminal" size={12} />
        <span>{demoMode ? 'Demo mode on' : 'Demo mode'}</span>
      </button>

      {version ? <span className="statusbar__version">v{version}</span> : null}
    </footer>
  );
}
