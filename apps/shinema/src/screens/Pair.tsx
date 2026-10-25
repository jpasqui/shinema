import { useState } from 'react';
import { Platform, View } from 'react-native';
import { ApiError, ShinemaApi } from '../../../../packages/core/src/index.ts';
import { useConnection } from '../connection';
import { Button } from '../kit/Button';
import { Screen } from '../kit/Screen';
import { Text } from '../kit/Text';
import { TextField } from '../kit/TextField';
import { space } from '../kit/theme';
import { useNavigation } from '../navigation';

function defaultDeviceName(): string {
  if (Platform.isTV) return 'Android TV';
  if (Platform.OS === 'web') return 'Web browser';
  return 'Android phone';
}

export function PairScreen({ origin }: { origin: string }) {
  const navigation = useNavigation();
  const { connect } = useConnection();
  const [code, setCode] = useState('');
  const [name, setName] = useState(defaultDeviceName());
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit() {
    setBusy(true);
    setError(null);
    try {
      const device = await new ShinemaApi({ origin }).claimPairing(code, name);
      await connect(origin, device.token, device.name);
      navigation.reset({ name: 'library' });
    } catch (problem) {
      setError(
        problem instanceof ApiError
          ? problem.message
          : 'Pairing failed. Check the code and try again.',
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <Screen style={{ justifyContent: 'center', padding: space.gutter }}>
      <View style={{ gap: space.lg, maxWidth: 560 }}>
        <Text variant="title">Pair this device</Text>
        <Text muted>
          The server prints a six-digit pairing code when it starts. You can
          also create one on the server computer. Codes last 10 minutes.
        </Text>
        <TextField
          label="Pairing code"
          value={code}
          onChangeText={setCode}
          placeholder="482-913"
          keyboardType="number-pad"
          maxLength={7}
          error={error}
          autoFocus
        />
        <TextField
          label="Device name"
          value={name}
          onChangeText={setName}
          maxLength={64}
          hint="Shown in the server's device list, so you can revoke it later."
        />
        <View style={{ flexDirection: 'row', gap: space.md }}>
          <Button
            label={busy ? 'Pairing…' : 'Pair'}
            onPress={submit}
            disabled={
              busy || code.replace(/\D/g, '').length !== 6 || !name.trim()
            }
          />
          <Button
            label="Change server"
            kind="secondary"
            onPress={() => navigation.back()}
          />
        </View>
      </View>
    </Screen>
  );
}
