/** Remote-control and keyboard input, normalised across platforms. */
export type RemoteKey =
  'up' | 'down' | 'left' | 'right' | 'select' | 'playPause' | 'back';

/** Return true when the key was handled, so default focus movement is skipped. */
export type RemoteHandler = (key: RemoteKey) => boolean;
