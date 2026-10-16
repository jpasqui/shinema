import React, { useEffect, useRef, useState } from 'react';
import {
  Animated,
  Image,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import type {
  ContentSupport,
  Media,
  Progress,
} from '../../../packages/contracts/index.ts';
import type {
  Theme,
  ThemeColors,
} from '../../../packages/design-tokens/theme.ts';
import type { LibraryDescriptor } from '../../../packages/contracts/index.ts';
import { feedSlotCount, feedWindow } from './feed.ts';
import { artworkUri } from './preferences.ts';
import {
  nativeGridFrame,
  nativeReservedGeometry,
  nativeSkinLayout,
} from './skin-layout.ts';

type SkinProps = {
  theme: Theme;
  width: number;
  height: number;
  reduced: boolean;
};
type Bounds = { y: number; height: number };
type LibraryProps = SkinProps & {
  origin: string;
  itemAt: (index: number) => Media | undefined;
  total: number;
  known: boolean;
  anchor: number;
  viewport: number;
  libraryName: string;
  contentSupport: (item: Media) => ContentSupport;
  errorAt: (index: number) => string | undefined;
  isLoading: (index: number) => boolean;
  onRetry: (index: number) => void;
  cursor: number;
  headerFocused: boolean;
  busy: boolean;
  progress: Record<string, Progress>;
  onSelect: (index: number) => void;
  onGridLayout: (bounds: Bounds) => void;
};
type DetailProps = SkinProps & {
  origin: string;
  item: Media;
  progress?: Progress;
  busy: boolean;
  focused: boolean;
  onPlay: () => void;
  onPlayLayout: (bounds: Bounds) => void;
};

/** These components own presentation only; catalogue, focus and playback stay in App. */
export function NativeHeader({
  theme,
  width,
  focused,
  headerCursor,
  libraries,
  selectedLibraryId,
  onLibrary,
  onAppearance,
}: {
  theme: Theme;
  width: number;
  focused: boolean;
  headerCursor: number;
  libraries: readonly LibraryDescriptor[];
  selectedLibraryId?: string;
  onLibrary: (library: LibraryDescriptor) => void;
  onAppearance: () => void;
}) {
  const archive = theme.design.skin === 'archive';
  const colors = theme.colors;
  const layout = nativeSkinLayout(theme, width, 720);
  const geometry = nativeReservedGeometry(theme, width, 720);
  const tabs = useRef<React.ComponentRef<typeof ScrollView>>(null);
  useEffect(() => {
    if (focused)
      tabs.current?.scrollTo({
        x: Math.max(0, Math.min(headerCursor, libraries.length - 1) * 136 - 16),
        animated: false,
      });
  }, [focused, headerCursor, libraries.length]);
  return (
    <View style={{ marginBottom: 16 }}>
      <View
        style={[
          base.header,
          { height: geometry.header, marginBottom: 8 },
          archive && { borderBottomWidth: 1, borderBottomColor: colors.muted },
        ]}
      >
        <View style={base.wordmark}>
          {!archive ? (
            <View
              style={[base.brandMark, { backgroundColor: colors.accent }]}
            />
          ) : null}
          <View style={{ flex: 1 }}>
            <Text
              numberOfLines={1}
              style={{
                height: 36,
                lineHeight: 36,
                color: colors.text,
                fontFamily: layout.fontFamily,
                fontSize: archive ? (width < 700 ? 26 : 30) : 28,
                letterSpacing: archive ? 0 : 1,
              }}
            >
              {archive
                ? width < 700
                  ? 'Shinema'
                  : 'Shinema / Archive'
                : 'shinema'}
            </Text>
            {archive ? (
              <Text
                numberOfLines={1}
                style={[
                  base.kicker,
                  {
                    height: 12,
                    lineHeight: 12,
                    color: colors.muted,
                    marginTop: 4,
                  },
                ]}
              >
                {width < 700
                  ? 'ARCHIVE / PRIVATE PROGRAMME'
                  : 'A PERSONAL PICTURE HOUSE'}
              </Text>
            ) : null}
          </View>
        </View>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Appearance and motion settings"
          style={[
            base.headerButton,
            {
              height: 44,
              borderRadius: archive ? 0 : 6,
              borderColor:
                focused && headerCursor === libraries.length
                  ? colors.focus
                  : colors.muted,
              backgroundColor: colors.surface,
            },
          ]}
          onPress={onAppearance}
        >
          <Text
            numberOfLines={1}
            style={{
              height: 18,
              lineHeight: 18,
              color: colors.text,
              fontSize: 13,
            }}
          >
            Appearance
          </Text>
        </Pressable>
      </View>
      <ScrollView
        ref={tabs}
        horizontal
        showsHorizontalScrollIndicator={false}
        style={{ height: geometry.navigation, maxHeight: geometry.navigation }}
        contentContainerStyle={{ gap: 8 }}
      >
        {libraries.map((library, index) => (
          <Pressable
            key={library.id}
            accessibilityRole="button"
            accessibilityState={{ selected: library.id === selectedLibraryId }}
            onPress={() => onLibrary(library)}
            style={{
              width: 128,
              height: 44,
              paddingHorizontal: 12,
              justifyContent: 'center',
              borderWidth: 2,
              borderColor:
                focused && headerCursor === index
                  ? colors.focus
                  : library.id === selectedLibraryId
                    ? colors.muted
                    : 'transparent',
              backgroundColor: colors.surface,
              borderRadius: archive ? 0 : 6,
            }}
          >
            <Text
              numberOfLines={1}
              style={{
                color: colors.text,
                lineHeight: 18,
                height: 18,
                fontFamily: layout.fontFamily,
              }}
            >
              {library.name}
            </Text>
          </Pressable>
        ))}
      </ScrollView>
    </View>
  );
}

function Artwork({
  uri,
  title,
  colors,
  reduced,
}: {
  uri?: string;
  title: string;
  colors: ThemeColors;
  reduced: boolean;
}) {
  const opacity = useRef(new Animated.Value(0)).current;
  const [loaded, setLoaded] = useState(false);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    opacity.stopAnimation();
    if (!loaded || failed) {
      opacity.setValue(0);
      return;
    }
    if (reduced) {
      opacity.setValue(1);
      return;
    }
    const animation = Animated.timing(opacity, {
      toValue: 1,
      duration: 180,
      useNativeDriver: true,
    });
    animation.start();
    return () => animation.stop();
  }, [loaded, failed, reduced, opacity]);
  return (
    <View
      accessible={false}
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      style={[
        StyleSheet.absoluteFill,
        { backgroundColor: colors.elevated, overflow: 'hidden' },
      ]}
    >
      <View style={base.placeholder}>
        <Text style={{ fontSize: 36, fontWeight: '500', color: colors.muted }}>
          {title.slice(0, 2).toUpperCase()}
        </Text>
        <Text style={{ color: colors.muted, fontSize: 11 }}>
          {failed
            ? 'Artwork unavailable'
            : uri
              ? 'Loading artwork'
              : 'No artwork'}
        </Text>
      </View>
      {uri && !failed ? (
        <Animated.View style={[StyleSheet.absoluteFill, { opacity }]}>
          <Image
            accessible={false}
            style={StyleSheet.absoluteFill}
            resizeMode="cover"
            source={{ uri }}
            onLoad={() => setLoaded(true)}
            onError={() => setFailed(true)}
          />
        </Animated.View>
      ) : null}
    </View>
  );
}

function imageFor(origin: string, item: Media | undefined, poster: boolean) {
  return (
    artworkUri(origin, item, poster ? 'poster' : 'backdrop') ??
    artworkUri(origin, item, poster ? 'backdrop' : 'poster')
  );
}

function MarqueeFeature({
  theme,
  width,
  height,
  reduced,
  origin,
  item,
  busy,
  artwork = true,
}: {
  theme: Theme;
  width: number;
  height: number;
  reduced: boolean;
  origin: string;
  item?: Media;
  busy: boolean;
  artwork?: boolean;
}) {
  const layout = nativeSkinLayout(theme, width, height);
  const geometry = nativeReservedGeometry(theme, width, height);
  const colors = theme.colors;
  const uri = artwork ? imageFor(origin, item, false) : undefined;
  return (
    <View
      style={{
        height: geometry.feature,
        borderRadius: 10,
        overflow: 'hidden',
        marginBottom: 16,
        backgroundColor: colors.surface,
      }}
    >
      <View
        style={{
          position: 'absolute',
          right: 0,
          top: 0,
          bottom: 0,
          width: '58%',
        }}
      >
        <Artwork
          key={uri ?? item?.id ?? 'empty'}
          uri={uri}
          title={item?.title ?? 'Your collection'}
          colors={colors}
          reduced={reduced}
        />
      </View>
      <View
        style={{
          width: '68%',
          height: '100%',
          padding: layout.dense ? 14 : 20,
          gap: 8,
          justifyContent: 'center',
          backgroundColor: colors.background,
        }}
      >
        <Text
          numberOfLines={1}
          style={[
            base.kicker,
            { height: 12, lineHeight: 12, color: colors.muted },
          ]}
        >
          {item ? 'TONIGHT, IN YOUR LIBRARY' : 'WELCOME HOME'}
        </Text>
        <Text
          style={{
            color: colors.text,
            fontFamily: layout.fontFamily,
            fontSize: layout.compact ? 26 : 32,
            height: geometry.featureTitle,
            lineHeight: geometry.featureTitleLine,
          }}
          numberOfLines={2}
        >
          {item?.title ??
            (busy ? 'A little anticipation.' : 'Your next great watch.')}
        </Text>
        <Text
          style={{
            height: geometry.featureSummary,
            color: colors.muted,
            fontSize: 13,
            lineHeight: 19,
          }}
          numberOfLines={2}
        >
          {item?.summary ??
            (item
              ? 'Select a title to explore and play.'
              : busy
                ? 'Connecting to your trusted library...'
                : 'Connect a server or refresh your library to begin.')}
        </Text>
      </View>
    </View>
  );
}

function ArchiveProgramme({
  theme,
  width,
  height,
  reduced,
  origin,
  item,
  busy,
  artwork = true,
}: {
  theme: Theme;
  width: number;
  height: number;
  reduced: boolean;
  origin: string;
  item?: Media;
  busy: boolean;
  artwork?: boolean;
}) {
  const layout = nativeSkinLayout(theme, width, height);
  const geometry = nativeReservedGeometry(theme, width, height);
  const colors = theme.colors;
  const uri = artwork ? imageFor(origin, item, true) : undefined;
  return (
    <View
      style={{ height: geometry.feature, marginBottom: 16, overflow: 'hidden' }}
    >
      <View style={[base.indexLine, { borderColor: colors.muted }]}>
        <Text
          numberOfLines={1}
          style={[
            base.kicker,
            { height: 12, lineHeight: 12, color: colors.muted },
          ]}
        >
          THE SCREENING ROOM
        </Text>
        <Text
          numberOfLines={1}
          style={[
            base.kicker,
            { height: 12, lineHeight: 12, color: colors.muted },
          ]}
        >
          YOUR PRIVATE PROGRAMME
        </Text>
      </View>
      <View
        style={{
          flex: 1,
          overflow: 'hidden',
          alignItems: 'center',
          flexDirection: 'row',
          gap: layout.dense ? 16 : 24,
          paddingVertical: layout.dense ? 12 : 18,
          borderBottomWidth: 1,
          borderBottomColor: colors.muted,
        }}
      >
        <View
          style={{
            width: layout.compact ? 86 : 100,
            height: layout.compact ? 129 : 150,
            backgroundColor: colors.surface,
          }}
        >
          <Artwork
            key={uri ?? item?.id ?? 'empty'}
            uri={uri}
            title={item?.title ?? 'Your collection'}
            colors={colors}
            reduced={reduced}
          />
        </View>
        <View style={{ flex: 1, justifyContent: 'center', gap: 8 }}>
          <Text
            numberOfLines={1}
            style={[
              base.kicker,
              { height: 12, lineHeight: 12, color: colors.muted },
            ]}
          >
            01 / FEATURED SELECTION
          </Text>
          <Text
            style={{
              fontFamily: layout.fontFamily,
              color: colors.text,
              fontSize: layout.compact ? 25 : 34,
              height: geometry.featureTitle,
              lineHeight: geometry.featureTitleLine,
            }}
            numberOfLines={2}
          >
            {item?.title ??
              (busy
                ? 'Preparing the programme.'
                : 'A collection to call your own.')}
          </Text>
          <Text
            style={{
              height: geometry.featureSummary,
              color: colors.muted,
              fontSize: 13,
              lineHeight: 19,
            }}
            numberOfLines={2}
          >
            {item?.summary ??
              'Films and series, carefully kept. Choose a title from the catalogue below.'}
          </Text>
          <Text
            numberOfLines={1}
            style={{
              height: geometry.featureMetadata,
              lineHeight: geometry.featureMetadata,
              fontSize: 12,
              color: colors.muted,
            }}
          >
            {item
              ? [
                  item.year,
                  item.collection === 'tv' ? 'SERIES' : 'FILM',
                  item.container.toUpperCase(),
                ]
                  .filter(Boolean)
                  .join(' / ')
              : ' '}
          </Text>
        </View>
      </View>
    </View>
  );
}

function LibraryCard({
  item,
  index,
  uri,
  focused,
  reduced,
  theme,
  width,
  height,
  progress,
  unavailableReason,
  onPress,
}: {
  item: Media;
  index: number;
  uri?: string;
  focused: boolean;
  reduced: boolean;
  theme: Theme;
  width: number;
  height: number;
  progress?: Progress;
  unavailableReason?: string;
  onPress: () => void;
}) {
  const scale = useRef(new Animated.Value(1)).current;
  const colors = theme.colors;
  const archive = theme.design.skin === 'archive';
  const poster = theme.design.cards === 'poster';
  const geometry = nativeReservedGeometry(theme, width, height);
  useEffect(() => {
    scale.stopAnimation();
    if (reduced) {
      scale.setValue(1);
      return;
    }
    const animation = Animated.timing(scale, {
      toValue: focused ? 1.035 : 1,
      duration: 140,
      useNativeDriver: true,
    });
    animation.start();
    return () => animation.stop();
  }, [focused, reduced, scale]);
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={item.title}
      accessibilityHint={unavailableReason}
      accessibilityState={{ selected: focused }}
      onPress={onPress}
      style={{
        width,
        height,
        padding: 5,
        borderWidth: 3,
        borderColor: focused ? colors.focus : 'transparent',
        borderRadius: archive ? 0 : 9,
        backgroundColor: archive ? colors.background : colors.surface,
      }}
    >
      <View
        style={{
          flex: 1,
          overflow: 'hidden',
          marginBottom: 6,
          backgroundColor: archive ? colors.surface : colors.elevated,
          borderRadius: archive ? 0 : 4,
        }}
      >
        <View
          style={{
            height: '100%',
            width: poster
              ? Math.min(width - 16, ((height - 66) * 2) / 3)
              : '100%',
            alignSelf: 'center',
            overflow: 'hidden',
          }}
        >
          <Animated.View
            style={[StyleSheet.absoluteFill, { transform: [{ scale }] }]}
          >
            <Artwork
              key={uri ?? item.id}
              uri={uri}
              title={item.title}
              colors={colors}
              reduced={reduced}
            />
          </Animated.View>
        </View>
      </View>
      <Text
        numberOfLines={1}
        style={{
          fontFamily:
            theme.design.typography === 'editorial' ? 'serif' : undefined,
          fontSize: 17,
          height: geometry.cardTitle,
          lineHeight: geometry.cardTitle,
          fontWeight: archive ? '400' : '600',
          color: colors.text,
          marginBottom: 3,
        }}
      >
        {archive ? `${String(index + 1).padStart(2, '0')} / ` : ''}
        {item.title}
      </Text>
      <Text
        numberOfLines={1}
        style={{
          height: geometry.cardMetadata,
          lineHeight: geometry.cardMetadata,
          fontSize: 12,
          color: colors.muted,
        }}
      >
        {[
          item.year,
          unavailableReason ? 'Unavailable' : item.container.toUpperCase(),
          progress
            ? `${Math.floor(progress.positionSeconds)} s watched`
            : undefined,
        ]
          .filter(Boolean)
          .join(' / ')}
      </Text>
    </Pressable>
  );
}

export function NativeLibrary(props: LibraryProps) {
  const {
    theme,
    width,
    height,
    reduced,
    origin,
    itemAt,
    total,
    known,
    anchor,
    viewport,
    cursor,
    headerFocused,
    busy,
    libraryName,
    contentSupport,
    onSelect,
    onGridLayout,
    onRetry,
    errorAt,
    isLoading,
  } = props;
  const layout = nativeSkinLayout(theme, width, height);
  const colors = theme.colors;
  const archive = theme.design.skin === 'archive';
  const window = feedWindow(
    feedSlotCount(known, total),
    anchor,
    layout.columns,
    layout.cardHeight + layout.gap,
    viewport,
  );
  const featured = itemAt(cursor);
  const featureProps = {
    theme,
    width,
    height,
    reduced,
    origin,
    item: featured,
    busy: busy || !known,
    artwork: !featured || contentSupport(featured).supported,
  };
  return (
    <View>
      {archive ? (
        <ArchiveProgramme {...featureProps} />
      ) : (
        <MarqueeFeature {...featureProps} />
      )}
      <View
        style={[
          base.sectionHeader,
          {
            height: 40,
            borderBottomWidth: archive ? 1 : 0,
            borderBottomColor: colors.muted,
            paddingBottom: archive ? 8 : 0,
          },
        ]}
      >
        <Text
          numberOfLines={1}
          style={{
            height: 30,
            lineHeight: 30,
            fontFamily: layout.fontFamily,
            fontSize: archive ? 24 : 19,
            color: colors.text,
            flex: 1,
          }}
        >
          {libraryName}
        </Text>
        <Text
          numberOfLines={1}
          style={{
            height: 16,
            lineHeight: 16,
            fontSize: 12,
            color: colors.muted,
          }}
        >
          {known ? String(total).padStart(2, '0') : '--'}{' '}
          {archive ? 'ENTRIES' : 'titles'}
        </Text>
      </View>
      <View
        style={{
          height: Math.max(layout.cardHeight, window.height),
          position: 'relative',
        }}
        onLayout={(event) => onGridLayout(event.nativeEvent.layout)}
      >
        {known && total === 0 ? (
          <View
            style={{
              height: layout.cardHeight,
              padding: 24,
              gap: 10,
              backgroundColor: colors.surface,
              borderRadius: archive ? 0 : 8,
            }}
          >
            <Text
              numberOfLines={2}
              style={{
                height: 60,
                lineHeight: 30,
                fontFamily: layout.fontFamily,
                fontSize: 22,
                color: colors.text,
              }}
            >
              The screen is yours.
            </Text>
            <Text
              numberOfLines={3}
              style={{
                height: 57,
                lineHeight: 19,
                color: colors.muted,
                fontSize: 13,
              }}
            >
              No titles are available in this library. Use Menu to check your
              server.
            </Text>
          </View>
        ) : (
          Array.from({ length: window.end - window.start }, (_, slot) => {
            const index = window.start + slot;
            const item = itemAt(index);
            const support = item ? contentSupport(item) : undefined;
            const error = errorAt(index);
            const pending = isLoading(index);
            return (
              <View
                key={index}
                style={{
                  position: 'absolute',
                  ...nativeGridFrame(theme, width, height, index),
                }}
              >
                {item ? (
                  <LibraryCard
                    item={item}
                    index={index}
                    uri={
                      support?.supported
                        ? imageFor(
                            origin,
                            item,
                            theme.design.cards === 'poster',
                          )
                        : undefined
                    }
                    unavailableReason={
                      support?.supported
                        ? undefined
                        : (support?.reason ?? 'This format is unavailable.')
                    }
                    focused={cursor === index && !headerFocused}
                    reduced={reduced}
                    theme={theme}
                    width={layout.cardWidth}
                    height={layout.cardHeight}
                    progress={props.progress[item.id]}
                    onPress={() => onSelect(index)}
                  />
                ) : (
                  <Pressable
                    accessibilityRole="button"
                    accessibilityLabel={
                      error
                        ? 'Retry loading title'
                        : pending
                          ? 'Loading title'
                          : 'Load title'
                    }
                    accessibilityState={{
                      selected: cursor === index && !headerFocused,
                      disabled: pending,
                    }}
                    onPress={() => onRetry(index)}
                    disabled={pending}
                    style={{
                      width: layout.cardWidth,
                      height: layout.cardHeight,
                      padding: 5,
                      borderWidth: 3,
                      borderColor:
                        cursor === index && !headerFocused
                          ? colors.focus
                          : 'transparent',
                      backgroundColor: colors.surface,
                      borderRadius: archive ? 0 : 9,
                    }}
                  >
                    <View
                      style={{
                        flex: 1,
                        backgroundColor: colors.elevated,
                        marginBottom: 6,
                      }}
                    />
                    <Text
                      numberOfLines={1}
                      style={{
                        height: 20,
                        lineHeight: 20,
                        color: colors.text,
                        fontSize: 17,
                      }}
                    >
                      {error
                        ? 'Title unavailable'
                        : pending
                          ? 'Loading...'
                          : 'Ready to load'}
                    </Text>
                    <Text
                      numberOfLines={1}
                      style={{
                        height: 16,
                        lineHeight: 16,
                        color: colors.muted,
                        fontSize: 12,
                      }}
                    >
                      {error ? 'Select to retry' : ' '}
                    </Text>
                  </Pressable>
                )}
              </View>
            );
          })
        )}
      </View>
    </View>
  );
}

/** Unsupported selections retain their identity without mounting remote artwork or controls. */
export function NativeUnavailable({
  theme,
  width,
  height,
  name,
  reason,
  instructions = 'Saved titles and progress stay on this device. Choose another library above.',
}: {
  theme: Theme;
  width: number;
  height: number;
  name: string;
  reason: string;
  instructions?: string;
}) {
  const layout = nativeSkinLayout(theme, width, height);
  const geometry = nativeReservedGeometry(theme, width, height);
  const colors = theme.colors;
  const archive = theme.design.skin === 'archive';
  return (
    <View>
      <View
        style={{
          height: geometry.feature,
          marginBottom: 16,
          padding: 24,
          justifyContent: 'center',
          gap: 10,
          backgroundColor: colors.surface,
          borderRadius: archive ? 0 : 10,
        }}
      >
        <Text
          numberOfLines={1}
          style={{
            height: 12,
            lineHeight: 12,
            fontSize: 10,
            letterSpacing: 2,
            color: colors.muted,
          }}
        >
          KEPT IN YOUR LIBRARY
        </Text>
        <Text
          numberOfLines={2}
          style={{
            height: geometry.featureTitle,
            lineHeight: geometry.featureTitleLine,
            fontFamily: layout.fontFamily,
            fontSize: layout.compact ? 26 : 34,
            color: colors.text,
          }}
        >
          {name}
        </Text>
      </View>
      <Text
        numberOfLines={1}
        style={{
          height: 40,
          lineHeight: 30,
          fontFamily: layout.fontFamily,
          fontSize: 19,
          color: colors.text,
        }}
      >
        Content unavailable on this device
      </Text>
      <View
        style={{
          height: layout.cardHeight,
          padding: 16,
          gap: 12,
          backgroundColor: colors.surface,
          borderRadius: archive ? 0 : 8,
        }}
      >
        <Text
          accessibilityLiveRegion="polite"
          numberOfLines={3}
          style={{
            height: 57,
            lineHeight: 19,
            fontSize: 14,
            color: colors.text,
          }}
        >
          {reason}
        </Text>
        <Text
          numberOfLines={2}
          style={{
            height: 38,
            lineHeight: 19,
            fontSize: 13,
            color: colors.muted,
          }}
        >
          {instructions}
        </Text>
      </View>
    </View>
  );
}

export function NativeDetail({
  theme,
  width,
  height,
  reduced,
  origin,
  item,
  progress,
  busy,
  focused,
  onPlay,
  onPlayLayout,
}: DetailProps) {
  const layout = nativeSkinLayout(theme, width, height);
  const geometry = nativeReservedGeometry(theme, width, height);
  const colors = theme.colors;
  const archive = theme.design.skin === 'archive';
  const uri = imageFor(origin, item, archive);
  const bodyTop = useRef(0);
  const copyTop = useRef(0);
  const playBounds = useRef<Bounds>({ y: 0, height: 0 });
  const notify = () => {
    if (playBounds.current.height)
      onPlayLayout({
        y:
          (archive ? bodyTop.current + copyTop.current : 0) +
          playBounds.current.y,
        height: playBounds.current.height,
      });
  };
  const typography = { fontFamily: layout.fontFamily, color: colors.text };
  const details = (
    <>
      <Text
        numberOfLines={2}
        style={[
          base.kicker,
          {
            height: geometry.detailKicker,
            lineHeight: 13,
            color: colors.muted,
          },
        ]}
      >
        {item.collection === 'tv'
          ? `${item.seriesTitle ?? 'SERIES'}${item.season !== undefined ? ` / SEASON ${item.season}` : ''}${item.episode !== undefined ? ` / EPISODE ${item.episode}` : ''}`
          : archive
            ? 'FILM / PROGRAMME NOTE'
            : 'FROM YOUR LIBRARY'}
      </Text>
      <Text
        numberOfLines={2}
        style={[
          typography,
          {
            height: geometry.detailTitle,
            lineHeight: geometry.detailTitleLine,
            fontSize: layout.compact ? 28 : 36,
          },
        ]}
      >
        {item.title}
      </Text>
      <Text
        numberOfLines={2}
        style={{
          height: geometry.detailMetadata,
          color: colors.muted,
          fontSize: 14,
          lineHeight: 21,
        }}
      >
        {[
          item.year,
          ...(item.genres ?? []).slice(0, 3),
          item.container.toUpperCase(),
          `${Math.round(item.sizeBytes / 1048576)} MiB`,
        ]
          .filter(Boolean)
          .join(' / ')}
      </Text>
      <Text
        numberOfLines={4}
        style={{
          height: geometry.detailSummary,
          color: colors.text,
          fontSize: 17,
          lineHeight: 25,
        }}
      >
        {item.summary ?? ' '}
      </Text>
      <Text
        numberOfLines={1}
        style={{
          height: geometry.resume,
          color: colors.muted,
          fontSize: 14,
          lineHeight: 21,
        }}
      >
        {progress && progress.positionSeconds < progress.durationSeconds - 3
          ? `Resume from ${Math.floor(progress.positionSeconds)} seconds`
          : 'Ready to play'}
      </Text>
      <Pressable
        accessibilityRole="button"
        onLayout={(event) => {
          playBounds.current = event.nativeEvent.layout;
          notify();
        }}
        style={{
          height: geometry.play,
          width: 260,
          maxWidth: '100%',
          justifyContent: 'center',
          backgroundColor: colors.accent,
          paddingVertical: 0,
          paddingHorizontal: 28,
          borderRadius: archive ? 0 : 6,
          borderWidth: 2,
          borderColor: focused ? colors.focus : 'transparent',
          alignSelf: 'flex-start',
        }}
        onPress={onPlay}
      >
        <Text
          numberOfLines={1}
          style={{
            height: 24,
            lineHeight: 24,
            fontSize: 20,
            fontWeight: '600',
            color: colors.onAccent,
          }}
        >
          {busy ? 'Checking resume...' : archive ? 'Start screening' : 'Play'}
        </Text>
      </Pressable>
      <Text
        numberOfLines={2}
        style={{
          height: geometry.instructions,
          color: colors.muted,
          fontSize: 12,
          lineHeight: 18,
        }}
      >
        Select: play Back: library Up: appearance Menu: server
      </Text>
    </>
  );
  return archive ? (
    <View style={{ gap: 16, paddingTop: 12 }}>
      <View style={[base.indexLine, { borderColor: colors.muted }]}>
        <Text
          numberOfLines={1}
          style={[
            base.kicker,
            { height: 12, lineHeight: 12, color: colors.muted },
          ]}
        >
          THE SCREENING ROOM / PROGRAMME
        </Text>
      </View>
      <View
        onLayout={(event) => {
          bodyTop.current = event.nativeEvent.layout.y;
          notify();
        }}
        style={{
          flexDirection: layout.compact ? 'column' : 'row',
          gap: layout.dense ? 18 : 32,
        }}
      >
        <View
          style={{
            width: layout.compact ? 150 : 230,
            height: layout.compact ? 225 : 345,
            alignSelf: layout.compact ? 'center' : 'flex-start',
          }}
        >
          <Artwork
            key={uri ?? item.id}
            uri={uri}
            title={item.title}
            colors={colors}
            reduced={reduced}
          />
        </View>
        <View
          onLayout={(event) => {
            copyTop.current = event.nativeEvent.layout.y;
            notify();
          }}
          style={{ flex: 1, gap: layout.dense ? 12 : 18 }}
        >
          {details}
        </View>
      </View>
    </View>
  ) : (
    <View
      style={{ gap: layout.dense ? 12 : 16, paddingTop: 12, maxWidth: 960 }}
    >
      <View
        style={{
          height: layout.compact ? 190 : 220,
          borderRadius: 10,
          overflow: 'hidden',
        }}
      >
        <Artwork
          key={uri ?? item.id}
          uri={uri}
          title={item.title}
          colors={colors}
          reduced={reduced}
        />
      </View>
      {details}
    </View>
  );
}

export function NativePlayerChrome({
  theme,
  title,
  loading,
  paused,
  clock,
  duration,
  message,
}: {
  theme: Theme;
  title: string;
  loading: boolean;
  paused: boolean;
  clock: number;
  duration: number;
  message: string;
}) {
  const colors = theme.colors;
  const archive = theme.design.skin === 'archive';
  const fontFamily =
    theme.design.typography === 'editorial'
      ? 'serif'
      : theme.design.typography === 'cinema'
        ? 'sans-serif-light'
        : 'sans-serif';
  const timeline = (
    <View
      style={{
        height: archive ? 2 : 4,
        borderRadius: archive ? 0 : 2,
        backgroundColor: colors.muted,
        overflow: 'hidden',
      }}
    >
      <View
        style={{
          height: '100%',
          backgroundColor: colors.focus,
          width: `${duration > 0 ? Math.min(100, (clock / duration) * 100) : 0}%`,
        }}
      />
    </View>
  );
  return (
    <View
      style={{
        position: 'absolute',
        bottom: 24,
        left: 28,
        right: 28,
        padding: theme.design.density === 'compact' ? 14 : 20,
        gap: 10,
        backgroundColor: colors.background,
        borderRadius: archive ? 0 : 8,
        borderTopWidth: archive ? 2 : 0,
        borderTopColor: colors.text,
      }}
    >
      {archive ? timeline : null}
      <Text
        numberOfLines={1}
        style={[
          base.kicker,
          { height: 12, lineHeight: 12, color: colors.muted },
        ]}
      >
        {archive
          ? 'SHINEMA ARCHIVE / SCREENING IN PROGRESS'
          : 'SHINEMA / NOW PLAYING'}
      </Text>
      <Text
        numberOfLines={2}
        style={{
          height: 64,
          lineHeight: 32,
          fontFamily,
          fontSize: archive ? 28 : 30,
          color: colors.text,
        }}
      >
        {title}
      </Text>
      {archive ? null : timeline}
      <Text
        numberOfLines={1}
        style={{ height: 22, lineHeight: 22, fontSize: 16, color: colors.text }}
      >
        {loading ? 'Loading...' : paused ? 'Paused' : 'Playing'}{' '}
        {Math.floor(clock)} / {Math.floor(duration)} s
      </Text>
      <Text
        numberOfLines={2}
        style={{
          height: 36,
          color: colors.muted,
          fontSize: 12,
          lineHeight: 18,
        }}
      >
        Select: pause / play Left / Right: seek Back: details
      </Text>
      <Text
        numberOfLines={2}
        style={{ height: 40, color: colors.text, fontSize: 14, lineHeight: 20 }}
      >
        {message || ' '}
      </Text>
    </View>
  );
}

const base = StyleSheet.create({
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    gap: 12,
    marginBottom: 16,
  },
  wordmark: {
    flex: 1,
    minWidth: 0,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
  },
  brandMark: { height: 24, width: 5, borderRadius: 2 },
  headerButton: { paddingVertical: 10, paddingHorizontal: 16, borderWidth: 2 },
  kicker: { fontSize: 10, fontWeight: '600', letterSpacing: 1.5 },
  placeholder: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    gap: 5,
  },
  indexLine: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    gap: 12,
    borderTopWidth: 1,
    paddingTop: 10,
  },
  sectionHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 10,
  },
});
