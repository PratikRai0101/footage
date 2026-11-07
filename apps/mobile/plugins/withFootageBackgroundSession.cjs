const { createHash } = require('node:crypto');
const { withAppDelegate } = require('expo/config-plugins');

// Expo 58.0.21's generated Footage AppDelegate. Fail closed on template drift or
// another callback owner: never silently omit the ownership boundary on upgrade.
const pristineSHA256 = 'a32411bd8ba43cd99b7580adaac49d0d7c6d469ce79b14721379dafac4b13b91';
const anchor = 'class AppDelegate: ExpoAppDelegate, ExpoReactNativeFactoryProvider {';
const routing = `
  // Footage owns exactly one stable session; all other owners keep Expo dispatch.
  public override func application(
    _ application: UIApplication,
    handleEventsForBackgroundURLSession identifier: String,
    completionHandler: @escaping () -> Void
  ) {
    if FootageBackgroundSessionRouter.handle(identifier, completionHandler: completionHandler) {
      return
    }
    super.application(application, handleEventsForBackgroundURLSession: identifier, completionHandler: completionHandler)
  }
`;
const hash = text => createHash('sha256').update(text).digest('hex');

function routeAppDelegate(contents, language) {
  const restored = contents.replace('internal import FootageTransfer\n', '').replace(routing, '');
  const pristine = hash(contents) === pristineSHA256;
  const alreadyRouted = hash(restored) === pristineSHA256 &&
    contents === restored.replace('internal import Expo\n', 'internal import Expo\ninternal import FootageTransfer\n')
      .replace(anchor, anchor + routing);
  if (language !== 'swift' || (!pristine && !alreadyRouted)) {
    throw new Error('Footage background-session routing: unsupported AppDelegate source. Expected the locked Expo 58.0.21 Footage template (or its exact routed output). Review the template/callback ownership before prebuilding; refusing to omit or duplicate the router.');
  }
  if (alreadyRouted) return contents;
  return contents.replace('internal import Expo\n', 'internal import Expo\ninternal import FootageTransfer\n')
    .replace(anchor, anchor + routing);
}

module.exports = config => withAppDelegate(config, config => {
  config.modResults.contents = routeAppDelegate(config.modResults.contents, config.modResults.language);
  return config;
});
module.exports.routeAppDelegate = routeAppDelegate;
