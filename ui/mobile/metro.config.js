const { getDefaultConfig } = require('expo/metro-config');
const path = require('path');

const config = getDefaultConfig(__dirname);

// ui/shared lives outside this app's root; Metro only watches/resolves
// within projectRoot by default, so it needs to be told about the sibling
// folder explicitly (standard Expo monorepo pattern).
config.watchFolders = [...(config.watchFolders ?? []), path.resolve(__dirname, '../shared')];

module.exports = config;
