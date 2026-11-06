// Explicit test-only initialization/cleanup. Normal listener only loads this exact item.
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { DesktopKeyStore } from '../../apps/server/src/desktop-key-store.ts';
const [out, operation] = process.argv.slice(2);
if (!out || !['initialize', 'delete'].includes(operation)) throw new Error('Explicit test operation required');
const { namespace } = JSON.parse(await readFile(join(out, 'receiver-config.json'), 'utf8'));
if (!/^test\.[0-9a-f-]{36}$/.test(namespace)) throw new Error('Test namespace required');
const config = { helper: join(out, 'key-helper'), namespace, allowTestKeychain: true };
if (operation === 'initialize') DesktopKeyStore.initialize(config);
else DesktopKeyStore.load(config).deleteTestItem();
