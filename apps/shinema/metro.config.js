// The app imports the shared packages from ../../packages, outside this
// project folder, so Metro must watch the repository root as well.
const path = require('path');
const { getDefaultConfig } = require('expo/metro-config');

const projectRoot = __dirname;
const repositoryRoot = path.resolve(projectRoot, '../..');

const config = getDefaultConfig(projectRoot);
config.watchFolders = [path.join(repositoryRoot, 'packages')];
config.resolver.nodeModulesPaths = [path.join(projectRoot, 'node_modules')];

module.exports = config;
