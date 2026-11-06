import { spawnSync } from 'node:child_process';
import { constants, closeSync, fstatSync, lstatSync, openSync } from 'node:fs';
import { dirname, isAbsolute } from 'node:path';
import { z } from 'zod';
import type { PairingKeyStore } from './pairing.js';

const namespaceSchema = z.union([z.literal('production'), z.string().regex(/^test\.[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/)]);
type Config = { helper: string } & ({ namespace: 'production' } | { namespace: string; allowTestKeychain: true });
function field(bytes: Buffer): Buffer { const size = Buffer.alloc(4); size.writeUInt32BE(bytes.length); return Buffer.concat([size, bytes]); }
function fail(): never { throw new Error('Desktop OS wrapping store unavailable or invalid.'); }

/** macOS ONLY. Compile the adjacent Swift source to a private, operator-owned
 * executable, then explicitly initialize once. Normal load never creates a key.
 * No receiver route, network approval command, platform fallback, or default instance.
 * Trust the local operator/helper install, just as the receiver executable itself.
 */
export class DesktopKeyStore implements PairingKeyStore {
  private constructor(private readonly config: Config) {
    if (process.platform !== 'darwin' || !isAbsolute(config.helper)) fail();
    namespaceSchema.parse(config.namespace);
    if (config.namespace !== 'production' && !('allowTestKeychain' in config && config.allowTestKeychain)) fail();
    // Reject symlinks, group/world writable executables/directories, and foreign owners.
    let path = config.helper;
    while (true) {
      const item = lstatSync(path);
      if (item.isSymbolicLink() || (item.mode & 0o022) !== 0 || (item.uid !== process.getuid?.() && item.uid !== 0)) fail();
      if (path === config.helper && (!item.isFile() || (item.mode & 0o111) === 0)) fail();
      const parent = dirname(path); if (parent === path) break; path = parent;
    }
    const fd = openSync(config.helper, constants.O_RDONLY | constants.O_NOFOLLOW);
    try { if (!fstatSync(fd).isFile()) fail(); } finally { closeSync(fd); }
  }
  static initialize(config: Config): DesktopKeyStore {
    const store = new DesktopKeyStore(config); store.exchange(1); return store;
  }
  static load(config: Config): DesktopKeyStore {
    const store = new DesktopKeyStore(config); store.exchange(2); return store;
  }
  /** Test runner only; deletes exactly its explicit UUID item, never production. */
  deleteTestItem(): void {
    if (this.config.namespace === 'production' || !('allowTestKeychain' in this.config)) fail();
    this.exchange(5);
  }
  wrap(plaintext: Buffer, context: string): Buffer { return this.exchange(3, plaintext, context); }
  unwrap(ciphertext: Buffer, context: string): Buffer { return this.exchange(4, ciphertext, context); }
  private exchange(op: number, body: Buffer = Buffer.alloc(0), context = ''): Buffer {
    const text = Buffer.from(context);
    if (text.length > 1024 || text.toString('utf8') !== context || context.includes('\0') || ((op === 3 || op === 4) && text.length === 0) || body.length > (op === 3 ? 65536 : 65564)) fail();
    const input = Buffer.concat([Buffer.from('FTOSKEY1'), Buffer.from([op]), field(Buffer.from(this.config.namespace)), field(text), field(body)]);
    const result = spawnSync(this.config.helper, [], { input, encoding: 'buffer', maxBuffer: 65564, timeout: 15000, env: {}, stdio: ['pipe', 'pipe', 'pipe', 'pipe'] });
    if (result.error || result.status !== 0 || result.signal || result.stderr.length !== 0) fail();
    const privateOutput = result.output[3];
    if (!Buffer.isBuffer(privateOutput)) fail();
    if (op === 4) {
      if (result.stdout.length !== 0 || privateOutput.length > 65536) fail();
      return privateOutput;
    }
    if (privateOutput.length !== 0 || (op !== 3 && result.stdout.length !== 0)) fail();
    return result.stdout;
  }
}
