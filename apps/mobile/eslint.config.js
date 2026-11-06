const { defineConfig } = require('eslint/config');
const expo = require('eslint-config-expo/flat');

module.exports = defineConfig([expo, {
  rules: {
    'no-restricted-properties': ['error', {
      object: 'StyleSheet',
      property: 'absoluteFillObject',
      message: 'Use StyleSheet.absoluteFill. absoluteFillObject is not exported by the installed React Native runtime.',
    }],
  },
}]);
