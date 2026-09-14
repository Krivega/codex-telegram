import type { Config } from '../config/config.ts';
import type { CodexPort } from '../types.ts';
import { CodexAdapter } from './adapter.ts';
import { CodexRpc } from './rpc.ts';
import { DesktopAdapter } from '../desktop/adapter.ts';

export function codexConnection(config: Pick<Config, 'hostId' | 'codex'>, directory: string): CodexPort {
  return config.codex.transport === 'desktop' ? new DesktopAdapter(directory, config)
    : new CodexAdapter(CodexRpc.overUnixSocket(config.codex.socketPath));
}
