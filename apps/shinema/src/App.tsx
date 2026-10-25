// Import single weights so only the five faces in use are bundled.
import { Figtree_400Regular } from '@expo-google-fonts/figtree/400Regular';
import { Figtree_500Medium } from '@expo-google-fonts/figtree/500Medium';
import { Figtree_700Bold } from '@expo-google-fonts/figtree/700Bold';
import { SourceSerif4_400Regular_Italic } from '@expo-google-fonts/source-serif-4/400Regular_Italic';
import { SourceSerif4_600SemiBold } from '@expo-google-fonts/source-serif-4/600SemiBold';
import { useFonts } from 'expo-font';
import * as SplashScreen from 'expo-splash-screen';
import { StatusBar } from 'expo-status-bar';
import { useEffect } from 'react';
import { View } from 'react-native';
import { ConnectionProvider, useConnection } from './connection';
import { ScreenFocusProvider } from './kit/focus-memory';
import { Message, Screen } from './kit/Screen';
import { colors } from './kit/theme';
import { NavigationProvider, useNavigation, type Route } from './navigation';
import { useArrowFocus } from './platform/remote';
import { ConnectScreen } from './screens/Connect';
import { DetailScreen } from './screens/Detail';
import { LibraryScreen } from './screens/Library';
import { PairScreen } from './screens/Pair';
import { PlayerScreen } from './screens/Player';
import { SeriesScreen } from './screens/Series';
import { SettingsScreen } from './screens/Settings';

void SplashScreen.preventAutoHideAsync().catch(() => {});

export default function App() {
  const [fontsLoaded, fontError] = useFonts({
    Figtree_400Regular,
    Figtree_500Medium,
    Figtree_700Bold,
    SourceSerif4_400Regular_Italic,
    SourceSerif4_600SemiBold,
  });
  useArrowFocus();
  const ready = fontsLoaded || fontError !== null;
  useEffect(() => {
    if (ready) void SplashScreen.hideAsync().catch(() => {});
  }, [ready]);
  if (!ready)
    return <View style={{ flex: 1, backgroundColor: colors.background }} />;
  return (
    <ConnectionProvider>
      <StatusBar hidden style="light" />
      <Root />
    </ConnectionProvider>
  );
}

function Root() {
  const connection = useConnection();
  if (connection.status === 'loading')
    return <View style={{ flex: 1, backgroundColor: colors.background }} />;
  if (connection.status === 'storageFailed')
    return (
      <Screen>
        <Message title="Shinema could not start" detail={connection.message} />
      </Screen>
    );
  return (
    <NavigationProvider
      initial={
        connection.status === 'connected'
          ? { name: 'library' }
          : { name: 'connect' }
      }
    >
      <Router />
    </NavigationProvider>
  );
}

/**
 * Screens below the top stay mounted but hidden, so going back to the
 * library returns to the same place in the grid.
 */
function Router() {
  const { stack } = useNavigation();
  const connection = useConnection();
  return (
    <>
      {stack.map((route, index) => {
        const top = index === stack.length - 1;
        // A screen that needs a server never renders without one.
        const needsServer = route.name !== 'connect' && route.name !== 'pair';
        return (
          <View key={index} style={{ flex: 1, display: top ? 'flex' : 'none' }}>
            <ScreenFocusProvider visible={top}>
              {needsServer && connection.status !== 'connected' ? (
                <ConnectScreen />
              ) : (
                <RouteScreen route={route} />
              )}
            </ScreenFocusProvider>
          </View>
        );
      })}
    </>
  );
}

function RouteScreen({ route }: { route: Route }) {
  switch (route.name) {
    case 'connect':
      return <ConnectScreen />;
    case 'pair':
      return <PairScreen origin={route.origin} />;
    case 'library':
      return <LibraryScreen />;
    case 'series':
      return <SeriesScreen series={route.series} />;
    case 'detail':
      return <DetailScreen media={route.media} />;
    case 'player':
      return <PlayerScreen media={route.media} start={route.start} />;
    case 'settings':
      return <SettingsScreen />;
  }
}
