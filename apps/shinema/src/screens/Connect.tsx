import { useState } from 'react';
import {
  ApiError,
  ShinemaApi,
  parseServerAddress,
} from '../../../../packages/core/src/index.ts';
import { useConnection } from '../connection';
import { Button } from '../kit/Button';
import { Panel } from '../kit/Panel';
import { Text } from '../kit/Text';
import { TextField } from '../kit/TextField';
import { useNavigation } from '../navigation';

export function ConnectScreen() {
  const navigation = useNavigation();
  const connection = useConnection();
  const { connect } = connection;
  // After upgrading from the old TV app, offer the server it used.
  const [address, setAddress] = useState(
    connection.status === 'disconnected'
      ? (connection.suggestedOrigin ?? '')
      : '',
  );
  const [error, setError] = useState<string | null>(null);
  const [warning, setWarning] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit() {
    setError(null);
    let parsed;
    try {
      parsed = parseServerAddress(address);
    } catch (problem) {
      setError(
        problem instanceof Error ? problem.message : 'Check the address.',
      );
      return;
    }
    if (!parsed.secure && !parsed.privateNetwork && warning === null) {
      setWarning(
        'This address is outside your home network and uses plain HTTP, so others could see what you watch. Select Connect again to continue anyway.',
      );
      return;
    }
    setBusy(true);
    try {
      const health = await new ShinemaApi({ origin: parsed.origin }).health();
      if (health.authRequired)
        navigation.push({ name: 'pair', origin: parsed.origin });
      else {
        await connect(parsed.origin, null, null);
        navigation.reset({ name: 'library' });
      }
    } catch (problem) {
      setError(
        problem instanceof ApiError && problem.kind !== 'network'
          ? 'That address answered, but it is not a Shinema server.'
          : 'Could not reach a Shinema server at that address. Check that the server is running and on the same network.',
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <Panel eyebrow="Your personal picture house" title="Connect your library">
      <>
        <Text muted>
          Enter the address of the computer running the Shinema server. It is
          printed when the server starts, for example 192.168.1.20:8787.
        </Text>
        <TextField
          label="Server address"
          value={address}
          onChangeText={(value) => {
            setAddress(value);
            setWarning(null);
          }}
          placeholder="192.168.1.20:8787"
          autoCapitalize="none"
          autoCorrect={false}
          keyboardType="url"
          returnKeyType="go"
          onSubmitEditing={submit}
          error={error}
          hint={warning ?? undefined}
          autoFocus
        />
        <Button
          label={busy ? 'Connecting…' : 'Connect'}
          onPress={submit}
          disabled={busy}
        />
      </>
    </Panel>
  );
}
