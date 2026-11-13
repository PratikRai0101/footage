import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import test from 'node:test';
const require = createRequire(import.meta.url);
const configure = require('../../apps/mobile/app.config.js');
const { expo: config } = require('../../apps/mobile/app.json');

test('ordinary app configuration remains unchanged', () => {
  const previous = process.env.FOOTAGE_ANDROID_VERIFY;
  try {
    delete process.env.FOOTAGE_ANDROID_VERIFY;
    assert.equal(configure({ config }), config);
  } finally {
    if (previous === undefined) delete process.env.FOOTAGE_ANDROID_VERIFY;
    else process.env.FOOTAGE_ANDROID_VERIFY = previous;
  }
});

test('physical verification has an isolated Android package and URI scheme', () => {
  const previous = process.env.FOOTAGE_ANDROID_VERIFY;
  try {
    process.env.FOOTAGE_ANDROID_VERIFY = '1';
    const result = configure({ config });
    assert.equal(result.android.package, 'dev.footage.verify');
    assert.equal(result.scheme, 'footage-verify');
    assert.equal(result.name, 'Footage Verify');
    assert.equal(result.version, config.version);
    assert.equal(result.android.versionCode, config.android.versionCode);
    assert.equal(result.ios, config.ios);
    assert.equal(result.plugins, config.plugins);
    assert.equal(config.android.package, 'dev.footage.spike');
  } finally {
    if (previous === undefined) delete process.env.FOOTAGE_ANDROID_VERIFY;
    else process.env.FOOTAGE_ANDROID_VERIFY = previous;
  }
});
