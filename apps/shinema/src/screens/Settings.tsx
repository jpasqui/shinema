import { useState } from 'react';
import { View } from 'react-native';
import { useConnected } from '../connection';
import { Button } from '../kit/Button';
import { Screen } from '../kit/Screen';
import { Text } from '../kit/Text';
import { space, useMetrics } from '../kit/theme';
import { useNavigation } from '../navigation';

export function SettingsScreen() {
  const { gutter } = useMetrics();
  const connection = useConnected();
  const navigation = useNavigation();
  const [syncMessage, setSyncMessage] = useState<string | null>(null);
  const pending = connection.progress.pendingCount();

  async function sync() {
    setSyncMessage('Syncing…');
    try {
      const result = await connection.progress.flush(connection.api);
      setSyncMessage(
        result.kept > 0
          ? `${result.kept} title${result.kept === 1 ? '' : 's'} could not be synced yet. They will be sent when the server is reachable.`
          : 'All progress is synced.',
      );
    } catch {
      setSyncMessage('Progress could not be synced. Try again later.');
    }
  }

  return (
    <Screen style={{ padding: gutter, gap: space.lg }}>
      <Text variant="title">Settings</Text>
      <View style={{ gap: space.xs }}>
        <Text variant="heading" muted>
          Server
        </Text>
        <Text>{connection.origin}</Text>
        {connection.deviceName ? (
          <Text variant="caption" muted>
            Paired as {connection.deviceName}
          </Text>
        ) : null}
      </View>
      <View style={{ gap: space.xs }}>
        <Text variant="heading" muted>
          Watch progress
        </Text>
        <Text>
          {pending === 0
            ? 'Everything you watched on this device is on the server.'
            : `${pending} title${pending === 1 ? '' : 's'} waiting to sync.`}
        </Text>
        {syncMessage ? (
          <Text variant="caption" muted>
            {syncMessage}
          </Text>
        ) : null}
      </View>
      <View style={{ flexDirection: 'row', gap: space.md }}>
        <Button label="Sync now" onPress={sync} preferred />
        <Button
          label="Change server"
          kind="secondary"
          onPress={async () => {
            await connection.forget();
            navigation.reset({ name: 'connect' });
          }}
        />
      </View>
      <Text variant="caption" muted>
        Changing server keeps this device's unsynced progress for this server
        and sends it if you reconnect.
      </Text>
    </Screen>
  );
}
