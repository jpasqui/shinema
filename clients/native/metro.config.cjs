const path = require('node:path');
const { getDefaultConfig, mergeConfig } = require('@react-native/metro-config');

module.exports = mergeConfig(getDefaultConfig(__dirname), {
  watchFolders: [
    path.resolve(__dirname, '../../packages/contracts'),
    path.resolve(__dirname, '../../packages/design-tokens'),
  ],
  // Shared source is outside this project, so resolve its transformed runtime
  // imports through the same installed dependencies as the native client.
  resolver: { nodeModulesPaths: [path.resolve(__dirname, 'node_modules')] },
});
