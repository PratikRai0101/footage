import { useEffect, useRef, useState, type ReactNode } from 'react';
import { AppState, Image, StyleSheet, View } from 'react-native';
import { useEvent, useEventListener } from 'expo';
import { useVideoPlayer, VideoView } from 'expo-video';
import type { MediaInfo } from '../../../modules/footage-transfer/src/contracts';
import { previewMetadata } from './preview-metadata';
import { CanvasShade } from './Readability';

export type PreviewState =
  | { kind: 'sample' }
  | { kind: 'loading' }
  | { kind: 'still' }
  | { kind: 'ready'; playFullFrame: () => void }
  | { kind: 'unavailable'; message: string };

type MetadataListener = (uri: string, media: MediaInfo) => void;
type Foreground = (state: PreviewState) => ReactNode;
type LocalVideoProps = { uri: string; interactive: boolean; onMetadata?: MetadataListener; children: Foreground };

function LocalVideo({ uri, interactive, onMetadata, children }: LocalVideoProps) {
  const view = useRef<VideoView>(null);
  const [fullscreen, setFullscreen] = useState(false);
  const [presentationFailed, setPresentationFailed] = useState(false);
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
  useEffect(() => {
    if (!interactive) player.pause();
  }, [interactive, player]);
  useEffect(() => {
    const listener = AppState.addEventListener('change', state => { if (state !== 'active') player.pause(); });
    return () => listener.remove();
  }, [player]);
  useEffect(() => {
    if (!fullscreen || !interactive) return;
    const mountedView = view.current;
    if (!mountedView) return;
    let active = true;
    void mountedView.enterFullscreen().then(() => {
      if (active) player.replay();
    }).catch(() => {
      if (active) { setFullscreen(false); setPresentationFailed(true); }
    });
    return () => { active = false; };
  }, [fullscreen, interactive, player]);

  let state: PreviewState;
  if (status === 'error' || presentationFailed) {
    state = { kind: 'unavailable', message: 'This video cannot be previewed here. Its original bytes can still be sent.' };
  } else if (status !== 'readyToPlay') {
    state = { kind: 'loading' };
  } else if (interactive) {
    state = { kind: 'ready', playFullFrame: () => setFullscreen(true) };
  } else {
    state = { kind: 'still' };
  }

  return <View style={styles.canvas} testID="local-preview-stage">
    <VideoView ref={view} player={player} style={StyleSheet.absoluteFill} contentFit={fullscreen ? 'contain' : 'cover'} surfaceType="textureView" nativeControls={fullscreen} fullscreenOptions={{ enable: true }} onFullscreenExit={() => { player.pause(); setFullscreen(false); }} pointerEvents={fullscreen ? 'auto' : 'none'} accessible={false} importantForAccessibility={fullscreen ? 'auto' : 'no-hide-descendants'} />
    <CanvasShade />
    {children(state)}
  </View>;
}

export function Preview({ uri, sample, interactive, onMetadata, children }: { uri: string | null; sample: boolean; interactive: boolean; onMetadata?: MetadataListener; children: Foreground }) {
  if (!sample && uri) return <LocalVideo key={uri} uri={uri} interactive={interactive} onMetadata={onMetadata}>{children}</LocalVideo>;
  return <View style={styles.canvas} testID="local-preview-stage">
    {sample && <Image source={require('../../../assets/sample-still.jpg')} style={StyleSheet.absoluteFill} resizeMode="cover" accessible={false} />}
    <CanvasShade />
    {children(sample ? { kind: 'sample' } : { kind: 'unavailable', message: 'A local preview is not available. Check the file details below.' })}
  </View>;
}

const styles = StyleSheet.create({ canvas: { flex: 1, backgroundColor: '#0b0b0b' } });
