const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { execFileSync } = require('node:child_process');
const { resolve } = require('node:path');
const { test } = require('node:test');
const { routeAppDelegate } = require('../../../apps/mobile/plugins/withFootageBackgroundSession.cjs');
const root = resolve(__dirname, '../../..');
const template = execFileSync('tar', ['-xOf', resolve(root, 'node_modules/expo/template.tgz'), 'package/ios/HelloWorld/AppDelegate.swift'], { encoding: 'utf8' });
const routed = routeAppDelegate(template, 'swift');

test('locked Expo template routing survives repeated runs without duplicating callback', () => {
  assert.equal(routeAppDelegate(routed, 'swift'), routed);
  assert.equal(routeAppDelegate(routeAppDelegate(routed, 'swift'), 'swift'), routed);
  assert.equal(routed.match(/handleEventsForBackgroundURLSession identifier/g).length, 1);
  assert.equal(routed.match(/FootageBackgroundSessionRouter.handle/g).length, 1);
  assert.match(routed, /if FootageBackgroundSessionRouter.handle\(identifier, completionHandler: completionHandler\) \{\s+return\s+\}\s+super.application\(application, handleEventsForBackgroundURLSession: identifier, completionHandler: completionHandler\)/);
  assert.ok(JSON.parse(readFileSync(resolve(root, 'apps/mobile/app.json'))).expo.plugins.includes('./plugins/withFootageBackgroundSession.cjs'));
});

test('unknown templates, language, altered or duplicate routers fail loudly', () => {
  for (const [source, language] of [[template, 'objc'], [template.replace('ExpoAppDelegate,', 'OtherAppDelegate,'), 'swift'],
    [routed.replace('completionHandler: completionHandler)', 'completionHandler: {})'), 'swift'],
    [routed + '\n// changed template', 'swift'], [routed + routed, 'swift']]) {
    assert.throws(() => routeAppDelegate(source, language), /unsupported AppDelegate source.*Review the template\/callback ownership/);
  }
});

test('subscriber remains early-launch/activity only, never a second session callback path', () => {
  const subscriber = readFileSync(resolve(root, 'apps/mobile/modules/footage-transfer/ios/FootageTransferAppDelegateSubscriber.swift'), 'utf8');
  assert.ok(subscriber.includes('subscriberDidRegister'));
  assert.ok(!subscriber.includes('handleEventsForBackgroundURLSession'));
});
