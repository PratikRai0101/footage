import { useEffect, useState } from 'react';
import { ActivityIndicator, AppState, Image, Pressable, StyleSheet, Text, View } from 'react-native';
import { useEvent, useEventListener } from 'expo';
import { useVideoPlayer, VideoView } from 'expo-video';
import { Icon } from './Icon';
import type { Theme } from './theme';
import type { MediaInfo } from '../../../modules/footage-transfer/src/contracts';
import { previewMetadata } from './preview-metadata';

type MetadataListener = (uri: string, media: MediaInfo) => void;

function LocalVideo({ uri, height, theme, interactive, onMetadata }: { uri: string; height: number; theme: Theme; interactive: boolean; onMetadata?: MetadataListener }) {
  const [controls, setControls] = useState(false);
  const player = useVideoPlayer(uri, value => {
    value.muted = true;
    value.keepScreenOnWhilePlaying = false;
    value.staysActiveInBackground = false;
  });
  const { status } = useEvent(player, 'statusChange', { status: player.status });
  useEventListener(player, 'playToEnd', () => setControls(false));
  useEventListener(player, 'sourceLoad', event => {
    const track = event.availableVideoTracks[0];
    onMetadata?.(uri, previewMetadata({ durationSeconds: event.duration, size: track?.size ?? null, mimeType: track?.mimeType ?? null }));
  });
  useEffect(() => {
    if (status !== 'readyToPlay' || !onMetadata) return;
    const track = player.availableVideoTracks[0];
    onMetadata(uri, previewMetadata({ durationSeconds: player.duration, size: track?.size ?? null, mimeType: track?.mimeType ?? null }));
  }, [onMetadata, player, status, uri]);
  useEffect(() => { if (!interactive) player.pause(); }, [interactive, player]);
  useEffect(() => {
    const listener = AppState.addEventListener('change', state => { if (state !== 'active') player.pause(); });
    return () => listener.remove();
  }, [player]);
  if (status === 'error') return <Unavailable theme={theme} message="This video cannot be previewed here. Its original bytes can still be sent." />;
  return <View style={{ height }}>
    <VideoView player={player} style={StyleSheet.absoluteFill} contentFit="contain" surfaceType="textureView" nativeControls={interactive && controls} fullscreenOptions={{ enable: true }} accessibilityLabel="Local original video preview" />
    {interactive && !controls && status === 'readyToPlay' && <View style={styles.playOverlay} pointerEvents="box-none"><Pressable onPress={() => { setControls(true); player.replay(); }} accessibilityRole="button" accessibilityLabel="Play local preview" style={styles.play}><Icon name="play" color="#f5f4f0" size={21} /></Pressable></View>}
    {status === 'loading' && <View pointerEvents="none" style={styles.loading}><ActivityIndicator color="#f5f4f0" accessibilityLabel="Loading video preview" /></View>}
  </View>;
}

function Unavailable({ theme, message }: { theme: Theme; message: string }) {
  return <View style={styles.unavailable}><Icon name="film" color={theme.colors.secondary} size={44} /><Text style={[styles.fallback, { color: theme.colors.secondary }]}>{message}</Text></View>;
}

export function Preview({ uri, sample, height, theme, interactive, onMetadata }: { uri: string | null; sample: boolean; height: number; theme: Theme; interactive: boolean; onMetadata?: MetadataListener }) {
  return <View testID="local-preview-stage" style={[styles.stage, { minHeight: height, borderColor: theme.colors.rule, backgroundColor: theme.colors.raised }]}>
    {sample ? <View style={{ height }}>
      <Image source={require('../../../assets/sample-still.jpg')} style={StyleSheet.absoluteFill} resizeMode="cover" accessibilityLabel="Dunes from the open movie Sintel. Sample still, not selected footage." />
      <View style={styles.sample}><Text style={styles.sampleText}>Sample still · Sintel</Text></View>
    </View> : uri ? <LocalVideo key={uri} uri={uri} height={height} theme={theme} interactive={interactive} onMetadata={onMetadata} /> : <Unavailable theme={theme} message="A local preview is not available. Check the file details below." />}
  </View>;
}

const styles = StyleSheet.create({
  stage: { justifyContent: 'center', width: '100%', borderRadius: 18, borderWidth: StyleSheet.hairlineWidth, overflow: 'hidden', backgroundColor: '#17191b' },
  unavailable: { alignItems: 'center', justifyContent: 'center', padding: 24, gap: 16 },
  fallback: { fontSize: 14, lineHeight: 21, textAlign: 'center', maxWidth: 300 },
  loading: { ...StyleSheet.absoluteFill, justifyContent: 'center', alignItems: 'center', backgroundColor: '#0b0c0d55' },
  playOverlay: { ...StyleSheet.absoluteFill, alignItems: 'center', justifyContent: 'center' },
  play: { width: 56, height: 56, borderRadius: 28, backgroundColor: '#101112dd', borderWidth: 1, borderColor: '#acadb080', alignItems: 'center', justifyContent: 'center' },
  sample: { position: 'absolute', bottom: 12, left: 12, borderRadius: 6, paddingVertical: 7, paddingHorizontal: 10, backgroundColor: '#0b0c0de8' },
  sampleText: { fontSize: 12, color: '#f5f4f0', fontWeight: '500' },
});
