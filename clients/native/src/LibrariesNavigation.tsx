import React, { useEffect, useRef } from 'react';
import { Pressable, ScrollView, StyleSheet, Text } from 'react-native';
import type { LibraryDescriptor } from '../../../packages/contracts/index.ts';

export default function LibrariesNavigation({
  libraries,
  selectedId,
  focusedIndex,
  onSelect,
}: {
  libraries: LibraryDescriptor[];
  selectedId: string | null;
  focusedIndex: number | null;
  onSelect: (id: string) => void;
}) {
  const scroll = useRef<React.ComponentRef<typeof ScrollView>>(null);
  const positions = useRef<Record<string, number>>({});
  const focusedId = libraries[focusedIndex ?? -1]?.id;
  useEffect(() => {
    const id = focusedId ?? selectedId;
    if (id)
      scroll.current?.scrollTo({
        x: Math.max(0, (positions.current[id] ?? 0) - 24),
        animated: false,
      });
  }, [focusedId, selectedId]);
  if (!libraries.length) return null;
  return (
    <ScrollView
      ref={scroll}
      horizontal
      style={styles.row}
      contentContainerStyle={styles.tabs}
      showsHorizontalScrollIndicator={false}
    >
      {libraries.map((library, index) => (
        <Pressable
          key={library.id}
          onLayout={(event) => {
            positions.current[library.id] = event.nativeEvent.layout.x;
          }}
          accessibilityRole="tab"
          accessibilityState={{ selected: selectedId === library.id }}
          style={[
            styles.tab,
            selectedId === library.id && styles.selected,
            focusedIndex === index && styles.focus,
          ]}
          onPress={() => onSelect(library.id)}
        >
          <Text style={styles.label}>{library.name}</Text>
        </Pressable>
      ))}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  row: { flexGrow: 0, marginBottom: 14 },
  tabs: { gap: 8, padding: 3 },
  tab: {
    paddingVertical: 9,
    paddingHorizontal: 16,
    borderWidth: 2,
    borderColor: 'transparent',
    borderRadius: 6,
    backgroundColor: '#1c2739',
  },
  selected: { backgroundColor: '#34546a' },
  focus: { borderColor: '#7ce8cb' },
  label: { color: '#e6f6f2', fontSize: 18 },
});
