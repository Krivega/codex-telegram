import { cp, mkdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateConfig, writePrivateJson } from '../config/config.ts';
import { validateNetworkConfig } from '../network/config.ts';
import { DesktopAdapter } from './adapter.ts';

export async function desktopConnection(directory: string): Promise<DesktopAdapter> {
  const raw = JSON.parse(await readFile(join(directory, 'config.json'), 'utf8'));
  const config = raw.version === 2 ? validateNetworkConfig(raw) : validateConfig(raw);
  if ('role' in config && config.role === 'hub') throw new Error('Desktop подключается на компьютере с Codex, а не на едином узле.');
  if (config.codex.transport !== 'desktop') throw new Error('Выберите codex.transport = desktop в настройках.');
  return new DesktopAdapter(directory, config);
}
export async function prepareDesktopPlugin(directory: string): Promise<string> {
  const connection = await desktopConnection(directory);
  connection.close();
  const repository = fileURLToPath(new URL('../../', import.meta.url));
  const plugin = join(directory, 'plugins', 'codex-telegram');
  await mkdir(dirname(plugin), { recursive: true, mode: 0o700 });
  await cp(join(repository, 'plugins', 'codex-telegram'), plugin, { recursive: true });
  await writePrivateJson(join(plugin, '.mcp.json'), { mcpServers: { codex_telegram: {
    command: process.execPath, args: [join(repository, 'bin', 'codex-telegram.mjs'), 'desktop', 'serve', '--home', directory],
  } } });
  const manifestPath = join(plugin, '.codex-plugin', 'plugin.json');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  await writePrivateJson(manifestPath, { ...manifest, mcpServers: './.mcp.json' });
  return plugin;
}
