import AsyncStorage from '@react-native-async-storage/async-storage';
import type { KeyValueStore } from '../../../../packages/core/src/index.ts';

/**
 * AsyncStorage on Android and localStorage on the web. Errors are passed
 * through: the shared core treats a failed read as an error, never as empty.
 */
export const store: KeyValueStore = {
  read: (key) => AsyncStorage.getItem(key),
  write: (key, value) => AsyncStorage.setItem(key, value),
  remove: (key) => AsyncStorage.removeItem(key),
};
