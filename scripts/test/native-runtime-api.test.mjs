import assert from 'node:assert/strict';
import { test } from 'node:test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ESLint } from 'eslint';

const mobile = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../apps/mobile');

async function runtimeApiMessages(property) {
  const eslint = new ESLint({ cwd: mobile });
  const results = await eslint.lintText(`import { StyleSheet } from 'react-native';\nexport const styles = StyleSheet.create({ media: { ...StyleSheet.${property}, width: '100%', height: '100%' } });\n`, { filePath: path.join(mobile, 'src/features/intake/runtime-api-check.tsx') });
  return results.flatMap(result => result.messages).filter(message => message.ruleId === 'no-restricted-properties');
}

test('the real removed React Native runtime API is rejected before another native build', async () => {
  const messages = await runtimeApiMessages('absoluteFillObject');
  assert.equal(messages.length, 1);
  assert.match(messages[0].message, /Use StyleSheet.absoluteFill/);
});

test('the installed absolute-fill API remains allowed', async () => {
  assert.deepEqual(await runtimeApiMessages('absoluteFill'), []);
});
