module.exports = ({ config }) => {
  if (process.env.FOOTAGE_ANDROID_VERIFY !== '1') return config;
  return {
    ...config,
    name: 'Footage Verify',
    scheme: 'footage-verify',
    android: { ...config.android, package: 'dev.footage.verify' },
  };
};
