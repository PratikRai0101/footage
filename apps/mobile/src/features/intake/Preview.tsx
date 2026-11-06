import { useEffect, useState, type ReactNode } from 'react';
import { AppState, Image, Modal, Pressable, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useEvent, useEventListener } from 'expo';
import { useVideoPlayer, VideoView } from 'expo-video';
import type { MediaInfo } from '../../../modules/footage-transfer/src/contracts';
import { previewMetadata } from './preview-metadata';
import { CanvasShade } from './Readability';
import { Icon } from './Icon';

export type PreviewState =
  | { kind: 'sample' }
  | { kind: 'loading' }
  | { kind: 'still' }
  | { kind: 'ready'; playFullFrame: () => void }
  | { kind: 'unavailable'; message: string };

type MetadataListener = (uri: string, media: MediaInfo) => void;
type Foreground = (state: PreviewState) => ReactNode;
type LocalVideoProps = { uri: string; interactive: boolean; reducedMotion: boolean; onMetadata?: MetadataListener; children: Foreground };

function LocalVideo({ uri, interactive, reducedMotion, onMetadata, children }: LocalVideoProps) {
  const [fullscreen, setFullscreen] = useState(false);
  const insets = useSafeAreaInsets();
  const player = useVideoPlayer(uri, value => {
    value.muted = true;
    value.keepScreenOnWhilePlaying = false;
    value.staysActiveInBackground = false;
  });
  const { status } = useEvent(player, 'statusChange', { status: player.status });
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

  function closePlayback() { player.pause(); setFullscreen(false); }

  let state: PreviewState;
  if (status === 'error') {
    state = { kind: 'unavailable', message: 'This video cannot be previewed here. Its original bytes can still be sent.' };
  } else if (status !== 'readyToPlay') {
    state = { kind: 'loading' };
  } else if (interactive) {
    state = { kind: 'ready', playFullFrame: () => setFullscreen(true) };
  } else {
    state = { kind: 'still' };
  }

  return <View style={styles.canvas} testID="local-preview-stage">
    {!fullscreen && <VideoView player={player} style={styles.media} contentFit="cover" surfaceType="textureView" nativeControls={false} allowsVideoFrameAnalysis={false} accessible={false} accessibilityElementsHidden importantForAccessibility="no-hide-descendants" />}
    <CanvasShade />
    {children(state)}
    <Modal visible={fullscreen} animationType={reducedMotion ? 'none' : 'fade'} presentationStyle="fullScreen" onRequestClose={closePlayback} onShow={() => player.replay()}>
      <View style={styles.playback} accessibilityViewIsModal>
        {fullscreen && <VideoView player={player} style={styles.media} contentFit="contain" surfaceType="textureView" nativeControls fullscreenOptions={{ enable: false }} allowsVideoFrameAnalysis={false} />}
        <View pointerEvents="box-none" style={[styles.closeArea, { paddingTop: insets.top }]}>
          <Pressable onPress={closePlayback} accessibilityRole="button" accessibilityLabel="Close preview" style={styles.close}><Icon name="close" color="#f4f1e9" size={23} /></Pressable>
        </View>
      </View>
    </Modal>
  </View>;
}

export function Preview({ uri, sample, interactive, reducedMotion, onMetadata, children }: { uri: string | null; sample: boolean; interactive: boolean; reducedMotion: boolean; onMetadata?: MetadataListener; children: Foreground }) {
  if (!sample && uri) return <LocalVideo key={uri} uri={uri} interactive={interactive} reducedMotion={reducedMotion} onMetadata={onMetadata}>{children}</LocalVideo>;
  return <View style={styles.canvas} testID="local-preview-stage">
    {sample && <Image source={require('../../../assets/sample-still.jpg')} style={styles.media} resizeMode="cover" accessible={false} accessibilityElementsHidden importantForAccessibility="no-hide-descendants" />}
    <CanvasShade />
    {children(sample ? { kind: 'sample' } : { kind: 'unavailable', message: 'A local preview is not available. Check the file details below.' })}
  </View>;
}

const styles = StyleSheet.create({
  canvas: { flex: 1, backgroundColor: '#0b0b0b' },
  media: { ...StyleSheet.absoluteFill, width: '100%', height: '100%' },
  playback: { flex: 1, backgroundColor: '#000000' },
  closeArea: { position: 'absolute', top: 0, left: 0, right: 0, paddingHorizontal: 20 },
  close: { width: 48, height: 48, borderRadius: 24, alignItems: 'center', justifyContent: 'center', backgroundColor: '#1b1a18cc', marginTop: 8 },
});
