import type { ReactNode } from 'react';
import { StyleSheet, View } from 'react-native';
import Svg, { Defs, LinearGradient, Rect, Stop } from 'react-native-svg';

const canvasStops: { offset: number; opacity: number }[] = [
  { offset: 0, opacity: .62 }, { offset: .27, opacity: .43 },
  { offset: .42, opacity: .25 }, { offset: .61, opacity: .74 },
  { offset: .83, opacity: .94 }, { offset: 1, opacity: .98 },
];

export function CanvasShade() {
  return <Svg pointerEvents="none" style={StyleSheet.absoluteFill} width="100%" height="100%" accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
    <Defs><LinearGradient id="canvas-shade" x1="0%" y1="0%" x2="0%" y2="100%">
      {canvasStops.map(stop => <Stop key={stop.offset} offset={stop.offset} stopColor="#0b0b0b" stopOpacity={stop.opacity} />)}
    </LinearGradient></Defs>
    <Rect width="100%" height="100%" fill="url(#canvas-shade)" />
  </Svg>;
}

function Edge({ entering }: { entering: boolean }) {
  return <Svg pointerEvents="none" width="100%" height={12} accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
    <Defs><LinearGradient id={entering ? 'band-top' : 'band-bottom'} x1="0%" y1="0%" x2="0%" y2="100%">
      <Stop offset={0} stopColor="#0b0b0b" stopOpacity={entering ? 0 : .84} />
      <Stop offset={1} stopColor="#0b0b0b" stopOpacity={entering ? .84 : 0} />
    </LinearGradient></Defs>
    <Rect width="100%" height="100%" fill={`url(#${entering ? 'band-top' : 'band-bottom'})`} />
  </Svg>;
}

export function Readability({ children }: { children: ReactNode }) {
  return <View style={styles.band}>
    <Edge entering />
    <View style={styles.content}>{children}</View>
    <Edge entering={false} />
  </View>;
}

const styles = StyleSheet.create({
  band: { marginHorizontal: -24 },
  content: { paddingHorizontal: 24, backgroundColor: '#0b0b0bd6', gap: 8 },
});
