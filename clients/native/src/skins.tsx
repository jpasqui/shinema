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
  ServerTransport,
} from '../../../packages/contracts/index.ts';
import type {
  Theme,
  ThemeColors,
} from '../../../packages/design-tokens/theme.ts';
import type { LibraryDescriptor } from '../../../packages/contracts/index.ts';
import { feedSlotCount, feedWindow } from './feed.ts';
import { artworkUri } from './preferences.ts';
import {
  nativeArtworkTypography,
  nativeDetailScene,
  nativeFeatureScene,
  nativeGridFrame,
  nativeHeaderScrollOffset,
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
  transport?: ServerTransport;
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
  transport?: ServerTransport;
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
  onRequests,
  onServer,
  onActionFocus,
}: {
  theme: Theme;
  width: number;
  focused: boolean;
  headerCursor: number;
  libraries: readonly LibraryDescriptor[];
  selectedLibraryId?: string;
  onLibrary: (library: LibraryDescriptor) => void;
  onAppearance: () => void;
  onRequests?: () => void;
  onServer?: () => void;
  onActionFocus?: (action: 'appearance' | 'requests' | 'server') => void;
}) {
  const archive = theme.design.skin === 'archive';
  const colors = theme.colors;
  const layout = nativeSkinLayout(theme, width, 720);
  const geometry = nativeReservedGeometry(theme, width, 720);
  const inline = !archive && !layout.compact;
  const tabs = useRef<React.ComponentRef<typeof ScrollView>>(null);
  const tabPositions = useRef<Record<number, number>>({});
  useEffect(() => {
    if (focused)
      tabs.current?.scrollTo({
        x: nativeHeaderScrollOffset(
          libraries.length,
          headerCursor,
          inline,
          tabPositions.current,
        ),
        animated: false,
      });
  }, [focused, headerCursor, libraries.length, inline, width]);
  if (inline) {
    const tab = (
      key: string,
      label: string,
      cursor: number,
      onPress: () => void,
      selected = false,
      action?: 'appearance' | 'requests' | 'server',
    ) => (
      <Pressable
        key={key}
        accessibilityRole="button"
        accessibilityLabel={
          action === 'appearance' ? 'Appearance and motion settings' : label
        }
        accessibilityState={{ selected }}
        onPress={onPress}
        onFocus={() => action && onActionFocus?.(action)}
        onLayout={(event) => {
          const x = event.nativeEvent.layout.x;
          tabPositions.current[cursor] = x;
          if (focused && headerCursor === cursor)
            tabs.current?.scrollTo({ x: Math.max(0, x - 12), animated: false });
        }}
        style={{
          width: 108,
          height: geometry.navigation,
          paddingHorizontal: 10,
          justifyContent: 'center',
          alignItems: 'center',
          borderWidth: 2,
          borderColor:
            focused && headerCursor === cursor ? colors.focus : 'transparent',
          borderRadius: 5,
          backgroundColor:
            focused && headerCursor === cursor ? colors.surface : 'transparent',
        }}
      >
        <Text
          numberOfLines={1}
          style={{
            height: 20,
            lineHeight: 20,
            fontSize: 14,
            fontFamily: layout.bodyFontFamily,
            color:
              selected || (focused && headerCursor === cursor)
                ? colors.text
                : colors.muted,
          }}
        >
          {label}
        </Text>
        <View
          style={{
            position: 'absolute',
            bottom: 1,
            height: 2,
            width: 26,
            backgroundColor: selected ? colors.accent : 'transparent',
          }}
        />
      </Pressable>
    );
    return (
      <View
        style={{
          height: geometry.header,
          marginBottom: geometry.headerMargin,
          flexDirection: 'row',
          alignItems: 'center',
          gap: 24,
        }}
      >
        <View
          style={{
            width: 142,
            flexDirection: 'row',
            alignItems: 'center',
            gap: 5,
          }}
        >
          <Text
            numberOfLines={1}
            style={{
              height: 38,
              lineHeight: 38,
              fontSize: 28,
              letterSpacing: -1,
              fontFamily: layout.displayFontFamily,
              color: colors.text,
            }}
          >
            shinema
          </Text>
          <View
            style={{
              width: 5,
              height: 5,
              borderRadius: 3,
              marginTop: 16,
              backgroundColor: colors.accent,
            }}
          />
        </View>
        <ScrollView
          ref={tabs}
          horizontal
          showsHorizontalScrollIndicator={false}
          style={{
            flex: 1,
            height: geometry.navigation,
            maxHeight: geometry.navigation,
          }}
          contentContainerStyle={{ gap: 8 }}
        >
          {libraries.map((library, index) =>
            tab(
              `library:${library.id}`,
              library.name,
              index,
              () => onLibrary(library),
              library.id === selectedLibraryId,
            ),
          )}
          {tab(
            'appearance',
            'Appearance',
            libraries.length,
            onAppearance,
            false,
            'appearance',
          )}
          {onRequests
            ? tab(
                'requests',
                'Requests',
                libraries.length + 1,
                onRequests,
                false,
                'requests',
              )
            : null}
          {onServer
            ? tab(
                'server',
                'Server',
                libraries.length + 2,
                onServer,
                false,
                'server',
              )
            : null}
        </ScrollView>
      </View>
    );
  }
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
                fontFamily: layout.displayFontFamily,
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
          onFocus={() => onActionFocus?.('appearance')}
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
        {onRequests ? (
          <Pressable
            accessibilityRole="button"
            accessibilityState={{
              selected: focused && headerCursor === libraries.length + 1,
            }}
            onPress={onRequests}
            onFocus={() => onActionFocus?.('requests')}
            style={{
              width: 128,
              height: 44,
              paddingHorizontal: 12,
              justifyContent: 'center',
              borderWidth: 2,
              borderColor:
                focused && headerCursor === libraries.length + 1
                  ? colors.focus
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
              Requests
            </Text>
          </Pressable>
        ) : null}
        {onServer ? (
          <Pressable
            accessibilityRole="button"
            accessibilityState={{
              selected: focused && headerCursor === libraries.length + 2,
            }}
            onPress={onServer}
            onFocus={() => onActionFocus?.('server')}
            style={{
              width: 128,
              height: 44,
              paddingHorizontal: 12,
              justifyContent: 'center',
              borderWidth: 2,
              borderColor:
                focused && headerCursor === libraries.length + 2
                  ? colors.focus
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
              Server
            </Text>
          </Pressable>
        ) : null}
      </ScrollView>
    </View>
  );
}

function Artwork({
  uri,
  title,
  colors,
  reduced,
  displayFontFamily = 'serif',
  coverWidth = 160,
  coverHeight = 240,
}: {
  uri?: string;
  title: string;
  colors: ThemeColors;
  reduced: boolean;
  displayFontFamily?: string;
  coverWidth?: number;
  coverHeight?: number;
}) {
  const cover = nativeArtworkTypography(coverWidth, coverHeight);
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
      <View
        style={{
          position: 'absolute',
          top: '12%',
          left: '16%',
          width: '92%',
          height: '80%',
          borderWidth: 1,
          borderColor: colors.muted,
          opacity: 0.12,
          transform: [{ rotate: '-13deg' }],
        }}
      />
      <View
        style={{
          position: 'absolute',
          top: '20%',
          left: '27%',
          width: '92%',
          height: '80%',
          borderWidth: 1,
          borderColor: colors.muted,
          opacity: 0.1,
          transform: [{ rotate: '-13deg' }],
        }}
      />
      <View
        style={{
          flex: 1,
          padding: cover.padding,
          gap: cover.gap,
          backgroundColor: colors.elevated,
        }}
      >
        {cover.kicker ? (
          <Text
            numberOfLines={1}
            style={{
              height: cover.kicker,
              lineHeight: cover.kicker,
              color: colors.muted,
              fontSize: 8,
              letterSpacing: 1.5,
            }}
          >
            SHINEMA
          </Text>
        ) : null}
        <View style={{ flex: 1, minHeight: 0, justifyContent: 'center' }}>
          <Text
            numberOfLines={cover.titleLines}
            style={{
              fontFamily: displayFontFamily,
              fontSize: cover.titleSize,
              lineHeight: cover.titleLine,
              color: colors.text,
            }}
          >
            {title}
          </Text>
          <View
            style={{
              marginTop: 8,
              height: 2,
              width: 22,
              backgroundColor: colors.accent,
            }}
          />
        </View>
        {cover.footer ? (
          <Text
            numberOfLines={1}
            style={{
              height: cover.footer,
              lineHeight: cover.footer,
              color: colors.muted,
              fontSize: 9,
            }}
          >
            {failed
              ? 'Artwork unavailable'
              : uri
                ? 'Loading artwork'
                : 'Library edition'}
          </Text>
        ) : null}
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

function imageFor(
  origin: string,
  item: Media | undefined,
  poster: boolean,
  transport?: ServerTransport,
) {
  return (
    artworkUri(origin, item, poster ? 'poster' : 'backdrop', transport) ??
    artworkUri(origin, item, poster ? 'backdrop' : 'poster', transport)
  );
}

function MarqueeFeature({
  theme,
  width,
  height,
  reduced,
  origin,
  transport,
  item,
  busy,
  artwork = true,
}: {
  theme: Theme;
  width: number;
  height: number;
  reduced: boolean;
  origin: string;
  transport?: ServerTransport;
  item?: Media;
  busy: boolean;
  artwork?: boolean;
}) {
  const layout = nativeSkinLayout(theme, width, height);
  const geometry = nativeReservedGeometry(theme, width, height);
  const colors = theme.colors;
  const backdrop = artwork
    ? artworkUri(origin, item, 'backdrop', transport)
    : undefined;
  const poster = artwork
    ? artworkUri(origin, item, 'poster', transport)
    : undefined;
  const uri = backdrop ?? poster;
  const posterOnly = !backdrop && Boolean(poster);
  const scene = nativeFeatureScene(theme, width, height, posterOnly);
  return (
    <View
      style={{
        height: geometry.feature,
        borderRadius: 8,
        overflow: 'hidden',
        marginBottom: 16,
        backgroundColor: colors.background,
      }}
    >
      <View
        style={{
          position: 'absolute',
          right: scene.artRight,
          top: scene.artTop,
          width: scene.artWidth,
          height: scene.artHeight,
          overflow: 'hidden',
          borderRadius: posterOnly ? 3 : 8,
        }}
      >
        <Artwork
          key={uri ?? item?.id ?? 'empty'}
          uri={uri}
          title={item?.title ?? 'Your collection'}
          colors={colors}
          reduced={reduced}
          displayFontFamily={layout.displayFontFamily}
          coverWidth={scene.artWidth}
          coverHeight={scene.artHeight}
        />
      </View>
      <View
        style={{
          width: scene.copyWidth,
          height: '100%',
          paddingVertical: geometry.featurePadding,
          paddingRight: geometry.featurePadding,
          gap: geometry.featureGap,
          justifyContent: 'center',
          backgroundColor: colors.background,
        }}
      >
        <Text
          numberOfLines={1}
          style={[
            base.kicker,
            {
              height: geometry.featureKicker,
              lineHeight: geometry.featureKicker,
              color: colors.muted,
            },
          ]}
        >
          {item ? 'IN YOUR COLLECTION' : busy ? 'YOUR LIBRARY' : 'WELCOME HOME'}
        </Text>
        <Text
          style={{
            color: colors.text,
            fontFamily: layout.displayFontFamily,
            fontSize: geometry.featureTitleLine - 2,
            height: geometry.featureTitle,
            lineHeight: geometry.featureTitleLine,
          }}
          numberOfLines={2}
        >
          {item?.title ??
            (busy ? 'Opening your library.' : 'Your next great watch.')}
        </Text>
        <Text
          numberOfLines={1}
          style={{
            height: geometry.featureMetadata,
            lineHeight: geometry.featureMetadata,
            color: colors.muted,
            fontSize: 11,
            fontFamily: layout.bodyFontFamily,
          }}
        >
          {item
            ? [
                item.year,
                ...(item.genres ?? []).slice(0, 2),
                item.container.toUpperCase(),
              ]
                .filter(Boolean)
                .join(' / ')
            : busy
              ? 'Loading titles and artwork'
              : 'Films and series, in one place'}
        </Text>
        <Text
          style={{
            height: geometry.featureSummary,
            color: colors.muted,
            fontSize: 13,
            lineHeight: 19,
            fontFamily: layout.bodyFontFamily,
          }}
          numberOfLines={2}
        >
          {item?.summary ??
            (item
              ? 'Choose a title below to see details, pick up where you left off, or start watching.'
              : busy
                ? 'Your collection will appear here. You can keep navigating while it loads.'
                : 'Choose a library above, or use Menu to check your server.')}
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
  transport,
  item,
  busy,
  artwork = true,
}: {
  theme: Theme;
  width: number;
  height: number;
  reduced: boolean;
  origin: string;
  transport?: ServerTransport;
  item?: Media;
  busy: boolean;
  artwork?: boolean;
}) {
  const layout = nativeSkinLayout(theme, width, height);
  const geometry = nativeReservedGeometry(theme, width, height);
  const colors = theme.colors;
  const uri = artwork ? imageFor(origin, item, true, transport) : undefined;
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
            displayFontFamily={layout.displayFontFamily}
            coverWidth={layout.compact ? 86 : 100}
            coverHeight={layout.compact ? 129 : 150}
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
              fontFamily: layout.displayFontFamily,
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
  layout,
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
  layout: ReturnType<typeof nativeSkinLayout>;
  progress?: Progress;
  unavailableReason?: string;
  onPress: () => void;
}) {
  const scale = useRef(new Animated.Value(1)).current;
  const colors = theme.colors;
  const archive = theme.design.skin === 'archive';
  useEffect(() => {
    scale.stopAnimation();
    if (reduced || theme.design.motion === 'still') {
      scale.setValue(1);
      return;
    }
    const animation = Animated.timing(scale, {
      toValue: focused ? 1.015 : 1,
      duration: 120,
      useNativeDriver: true,
    });
    animation.start();
    return () => animation.stop();
  }, [focused, reduced, scale, theme.design.motion]);
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={item.title}
      accessibilityHint={unavailableReason}
      accessibilityState={{ selected: focused }}
      onPress={onPress}
      style={{
        width: layout.cardWidth,
        height: layout.cardHeight,
        padding: layout.cardPadding,
        borderWidth: layout.cardBorder,
        borderColor: focused ? colors.focus : 'transparent',
        borderRadius: archive ? 0 : 5,
        backgroundColor:
          focused && !archive ? colors.surface : colors.background,
      }}
    >
      <View
        style={{
          width: layout.cardImageWidth,
          height: layout.cardImageHeight,
          alignItems: 'center',
          justifyContent: 'center',
          overflow: 'hidden',
          marginBottom: layout.cardCaptionGap,
          backgroundColor: archive ? colors.surface : colors.elevated,
          borderRadius: archive ? 0 : 4,
        }}
      >
        <View
          style={{
            height: layout.cardArtHeight,
            width: layout.cardArtWidth,
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
              displayFontFamily={layout.displayFontFamily}
              coverWidth={layout.cardArtWidth}
              coverHeight={layout.cardArtHeight}
            />
          </Animated.View>
        </View>
      </View>
      <Text
        numberOfLines={2}
        style={{
          fontFamily: layout.bodyFontFamily,
          fontSize: layout.cardTitleSize,
          height: layout.cardTitleHeight,
          lineHeight: layout.cardTitleLine,
          fontWeight: archive ? '400' : '500',
          color: colors.text,
          marginBottom: layout.cardMetadataGap,
        }}
      >
        {archive ? `${String(index + 1).padStart(2, '0')} / ` : ''}
        {item.title}
      </Text>
      <Text
        numberOfLines={1}
        style={{
          height: layout.cardMetadataHeight,
          lineHeight: layout.cardMetadataHeight,
          fontSize: 11,
          fontFamily: layout.bodyFontFamily,
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
    transport,
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
    transport,
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
            fontFamily: layout.displayFontFamily,
            fontSize: archive ? 24 : 22,
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
              padding: 16,
              gap: 10,
              backgroundColor: colors.surface,
              borderRadius: archive ? 0 : 8,
            }}
          >
            <Text
              numberOfLines={2}
              style={{
                height: 44,
                lineHeight: 22,
                fontFamily: layout.displayFontFamily,
                fontSize: 20,
                color: colors.text,
              }}
            >
              The screen is yours.
            </Text>
            <Text
              numberOfLines={2}
              style={{
                height: 38,
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
                            transport,
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
                    layout={layout}
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
                      padding: layout.cardPadding,
                      borderWidth: layout.cardBorder,
                      borderColor:
                        cursor === index && !headerFocused
                          ? colors.focus
                          : 'transparent',
                      backgroundColor:
                        cursor === index && !headerFocused
                          ? colors.surface
                          : colors.background,
                      borderRadius: archive ? 0 : 5,
                    }}
                  >
                    <View
                      style={{
                        width: layout.cardImageWidth,
                        height: layout.cardImageHeight,
                        backgroundColor: colors.elevated,
                        borderRadius: archive ? 0 : 4,
                        marginBottom: layout.cardCaptionGap,
                        alignItems: 'center',
                        justifyContent: 'center',
                      }}
                    >
                      <View
                        style={{
                          width: 24,
                          height: 1,
                          backgroundColor: colors.muted,
                          opacity: 0.4,
                        }}
                      />
                    </View>
                    <Text
                      numberOfLines={2}
                      style={{
                        height: layout.cardTitleHeight,
                        lineHeight: layout.cardTitleLine,
                        color: colors.text,
                        fontSize: layout.cardTitleSize,
                        fontFamily: layout.bodyFontFamily,
                        marginBottom: layout.cardMetadataGap,
                      }}
                    >
                      {error
                        ? 'Title unavailable'
                        : pending
                          ? 'Loading...'
                          : 'Title ready to load'}
                    </Text>
                    <Text
                      numberOfLines={1}
                      style={{
                        height: layout.cardMetadataHeight,
                        lineHeight: layout.cardMetadataHeight,
                        color: colors.muted,
                        fontSize: 11,
                        fontFamily: layout.bodyFontFamily,
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
            fontFamily: layout.displayFontFamily,
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
  transport,
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
  const uri = imageFor(origin, item, archive, transport);
  const tvMarquee = !archive && !layout.compact;
  const bodyTop = useRef(0);
  const copyTop = useRef(0);
  const playBounds = useRef<Bounds>({ y: 0, height: 0 });
  const notify = () => {
    if (playBounds.current.height)
      onPlayLayout({
        y:
          (archive || tvMarquee ? bodyTop.current + copyTop.current : 0) +
          playBounds.current.y,
        height: playBounds.current.height,
      });
  };
  const typography = {
    fontFamily: layout.displayFontFamily,
    color: colors.text,
  };
  const details = (
    <>
      <Text
        numberOfLines={tvMarquee ? 1 : 2}
        style={[
          base.kicker,
          {
            height: geometry.detailKicker,
            lineHeight: tvMarquee ? 14 : 13,
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
            fontSize: tvMarquee
              ? geometry.detailTitleLine - 2
              : layout.compact
                ? 28
                : 36,
          },
        ]}
      >
        {item.title}
      </Text>
      <Text
        numberOfLines={tvMarquee ? 1 : 2}
        style={{
          height: geometry.detailMetadata,
          color: colors.muted,
          fontSize: tvMarquee ? 12 : 14,
          lineHeight: geometry.detailMetadataLine,
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
        numberOfLines={geometry.detailSummaryLines}
        style={{
          height: geometry.detailSummary,
          color: colors.text,
          fontFamily: layout.bodyFontFamily,
          fontSize: tvMarquee ? 14 : 17,
          lineHeight: geometry.detailSummaryLine,
        }}
      >
        {item.summary ?? ' '}
      </Text>
      <Text
        numberOfLines={1}
        style={{
          height: geometry.resume,
          color: colors.muted,
          fontSize: tvMarquee ? 12 : 14,
          lineHeight: geometry.resume,
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
          lineHeight: tvMarquee ? 14 : 18,
        }}
      >
        Select: play Back: library Up: appearance Menu: server
      </Text>
    </>
  );
  if (tvMarquee) {
    const posterOnly =
      !artworkUri(origin, item, 'backdrop', transport) &&
      Boolean(artworkUri(origin, item, 'poster', transport));
    const scene = nativeDetailScene(theme, width, height, posterOnly);
    return (
      <View
        onLayout={(event) => {
          bodyTop.current = event.nativeEvent.layout.y;
          notify();
        }}
        style={{
          paddingTop: geometry.detailPaddingTop,
          height: scene.height,
          position: 'relative',
        }}
      >
        <View
          style={{
            position: 'absolute',
            top: scene.artTop,
            right: 0,
            width: scene.artWidth,
            height: scene.artHeight,
            overflow: 'hidden',
            borderRadius: 6,
          }}
        >
          <Artwork
            key={uri ?? item.id}
            uri={uri}
            title={item.title}
            colors={colors}
            reduced={reduced}
            displayFontFamily={layout.displayFontFamily}
            coverWidth={scene.artWidth}
            coverHeight={scene.artHeight}
          />
        </View>
        <View
          onLayout={(event) => {
            copyTop.current = event.nativeEvent.layout.y;
            notify();
          }}
          style={{
            width: scene.copyWidth,
            paddingRight: 24,
            gap: geometry.detailGap,
            backgroundColor: colors.background,
          }}
        >
          {details}
        </View>
      </View>
    );
  }
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
            displayFontFamily={layout.displayFontFamily}
            coverWidth={layout.compact ? 150 : 230}
            coverHeight={layout.compact ? 225 : 345}
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
          displayFontFamily={layout.displayFontFamily}
          coverWidth={width - layout.inset * 2}
          coverHeight={layout.compact ? 190 : 220}
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
  subtitleStatus,
  onSubtitles,
}: {
  theme: Theme;
  title: string;
  loading: boolean;
  paused: boolean;
  clock: number;
  duration: number;
  message: string;
  subtitleStatus?: string;
  onSubtitles?: () => void;
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
        Select: pause / play Left / Right: seek Menu: subtitles Back: details
      </Text>
      {onSubtitles ? (
        <Pressable accessibilityRole="button" onPress={onSubtitles}>
          <Text
            numberOfLines={2}
            style={{
              minHeight: 40,
              color: colors.text,
              fontSize: 14,
              lineHeight: 20,
            }}
          >
            {subtitleStatus}
          </Text>
        </Pressable>
      ) : null}
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
