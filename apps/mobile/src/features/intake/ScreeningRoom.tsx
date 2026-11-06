import { useEffect, useState } from 'react';
import { AccessibilityInfo, ActivityIndicator, Alert, Animated, Easing, Platform, Pressable, ScrollView, StyleSheet, Text, useWindowDimensions, useAnimatedValue, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { StatusBar } from 'expo-status-bar';
import { copyFor, formatBytes, fractionFor, mediaLine, present, type Command, type Stage } from './presentation';
import { useTransfer } from './useTransfer';
import { useScreeningTheme, type Theme } from './theme';
import { Preview, type PreviewState } from './Preview';
import { Readability } from './Readability';
import { Icon } from './Icon';
import { SettingsSheet } from './SettingsSheet';

function Progress({ stage, theme, reducedMotion, compact }: { stage: Stage; theme: Theme; reducedMotion: boolean; compact: boolean }) {
  const fraction = fractionFor(stage);
  const motion = useAnimatedValue(fraction ?? 0);
  useEffect(() => {
    const animation = Animated.timing(motion, { toValue: fraction ?? 0, duration: reducedMotion ? 0 : 200, easing: Easing.out(Easing.cubic), useNativeDriver: true });
    animation.start();
    return () => animation.stop();
  }, [fraction, motion, reducedMotion]);
  if ((stage.kind !== 'saved' && stage.kind !== 'preparing') || (stage.kind === 'saved' && ['cancelled', 'verifying', 'received'].includes(stage.snapshot.kind))) return null;
  const caption = stage.kind === 'preparing'
    ? stage.copiedBytes === null ? 'Starting preparation' : `${formatBytes(stage.copiedBytes)} copied${stage.clip.bytes ? ` / ${formatBytes(stage.clip.bytes)}` : ''}`
    : `${formatBytes(stage.snapshot.confirmedBytes)} / ${formatBytes(stage.snapshot.bytes)}`;
  return <View style={styles.progressSection}>
    <View style={styles.percentage}><Text style={[styles.number, compact && styles.compactNumber, { color: theme.colors.ink }]}>{fraction === null ? '—' : Math.floor(fraction * 100)}</Text>{fraction !== null && <Text style={[styles.unit, { color: theme.colors.ink }]}>%</Text>}</View>
    <Text style={[styles.byteCount, { color: theme.colors.ink }]}>{caption}</Text>
    <View accessibilityRole="progressbar" accessibilityLabel={caption} accessibilityValue={fraction === null ? { text: caption } : { min: 0, max: 100, now: Math.floor(fraction * 100) }} style={[styles.track, { backgroundColor: theme.colors.rule }]}>
      <Animated.View style={[StyleSheet.absoluteFill, { backgroundColor: theme.colors.ink, transform: [{ scaleX: motion }], transformOrigin: 'left center' }]} />
    </View>
  </View>;
}

function PlaybackControl({ state, theme }: { state: PreviewState; theme: Theme }) {
  switch (state.kind) {
    case 'ready': return <View style={styles.playback}>
      <Pressable onPress={state.playFullFrame} accessibilityRole="button" accessibilityLabel="Play local preview" accessibilityHint="Opens full-frame playback" style={({ pressed }) => [styles.play, { opacity: pressed ? .65 : 1 }]}><Icon name="play" color={theme.colors.ink} size={23} /></Pressable>
      <Text style={[styles.playLabel, { color: theme.colors.ink }]}>Full-frame playback</Text>
    </View>;
    case 'loading': return <ActivityIndicator color={theme.colors.ink} accessibilityLabel="Loading video preview" />;
    case 'unavailable': return <View style={styles.unavailable}><Readability><View style={styles.fallbackRow}><Icon name="film" color={theme.colors.secondary} size={28} /><Text style={[styles.support, { color: theme.colors.secondary, flex: 1 }]}>{state.message}</Text></View></Readability></View>;
    case 'sample': case 'still': return null;
    default: { const exhaustive: never = state; return exhaustive; }
  }
}

function Action({ label, primary, upload, disabled, onPress, theme }: { label: string; primary: boolean; upload: boolean; disabled: boolean; onPress: () => void; theme: Theme }) {
  const color = primary ? theme.colors.onAction : theme.colors.secondary;
  return <Pressable onPress={onPress} disabled={disabled} accessibilityRole="button" accessibilityLabel={label} accessibilityState={{ disabled }} style={({ pressed }) => [styles.action, { backgroundColor: primary ? theme.colors.action : 'transparent', opacity: pressed || disabled ? .55 : 1 }]}>
    {upload && <Icon name="upload" color={color} size={19} />}
    <Text style={[styles.actionText, { color, fontWeight: primary ? '600' : '400' }]}>{label}</Text>
  </Pressable>;
}

export function ScreeningRoom() {
  const flow = useTransfer();
  const theme = useScreeningTheme(flow.settings.appearance);
  const photoTheme: Theme = { ...theme, colors: theme.photo };
  const c = photoTheme.colors;
  const dimensions = useWindowDimensions();
  const compact = dimensions.height < 740;
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [reducedMotion, setReducedMotion] = useState(false);
  useEffect(() => {
    let mounted = true;
    void AccessibilityInfo.isReduceMotionEnabled().then(value => { if (mounted) setReducedMotion(value); });
    const listener = AccessibilityInfo.addEventListener('reduceMotionChanged', setReducedMotion);
    return () => { mounted = false; listener.remove(); };
  }, []);
  const stage = present(flow.snapshot, flow.draft);
  const copy = copyFor(stage, flow.available ? 'transfer' : 'preview');
  const clip = stage.kind === 'import' ? null : stage.clip;
  const received = stage.kind === 'saved' && stage.snapshot.kind === 'received' ? stage.snapshot : null;
  const playable = stage.kind === 'saved' ? stage.snapshot.kind !== 'cancelled' : true;
  const foregroundUpload = Platform.OS === 'ios' && flow.available;
  const assurance = stage.kind === 'review' && flow.available
    ? foregroundUpload ? `${copy.body}\nKeep Footage open while uploading.` : copy.body : null;
  const statusBody = foregroundUpload && stage.kind === 'saved' && stage.snapshot.kind === 'waiting'
    ? 'Keep Footage open while uploading. Tap Continue to resume.'
    : foregroundUpload && stage.kind === 'saved' && ['ready', 'uploading', 'verifying'].includes(stage.snapshot.kind)
      ? 'Keep Footage open while uploading.' : assurance ? null : copy.body;
  const showStatus = copy.label !== null || statusBody !== null || stage.kind === 'preparing' || stage.kind === 'saved';
  const blockedUpload = copy.primary?.command === 'upload' && (!flow.available || flow.device?.supportsTransfer === false);

  function perform(command: Command) {
    switch (command) {
      case 'choose': void flow.choose(); return;
      case 'upload': if (!flow.settings.origin) setSettingsOpen(true); else void flow.upload(); return;
      case 'resume': void flow.resume(); return;
      case 'cancel': case 'cleanup': void flow.cancel(); return;
      case 'viewer': void flow.view(); return;
      default: { const exhaustive: never = command; return exhaustive; }
    }
  }

  return <View style={styles.safe}>
    <StatusBar style="light" />
    <Preview reducedMotion={reducedMotion} sample={stage.kind === 'import'} uri={clip && playable ? clip.uri : null} interactive={stage.kind === 'review' || received !== null} onMetadata={flow.available ? undefined : flow.recordPreviewMetadata}>
      {preview => <>
        <SafeAreaView edges={['top', 'left', 'right']} style={styles.safe}>
          <ScrollView style={styles.scroll} contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
            <View style={styles.brand}>
              <Text style={[styles.wordmark, { color: c.ink, fontFamily: theme.display }]}>Footage</Text>
              <Pressable onPress={() => setSettingsOpen(true)} accessibilityRole="button" accessibilityLabel="Settings" style={({ pressed }) => [styles.iconButton, styles.settingsButton, { opacity: pressed ? .6 : 1 }]}><Icon name="settings" color={c.ink} size={22} /></Pressable>
            </View>
            <Text accessibilityRole="header" style={[styles.title, compact && styles.compactTitle, { color: c.ink, fontFamily: theme.display }]}>{copy.title}</Text>
            <View style={[styles.hero, { minHeight: compact ? 100 : 160 }]}><PlaybackControl state={preview} theme={photoTheme} /></View>
            {preview.kind === 'sample' && <Text style={[styles.small, { color: c.secondary }]}>Sample still · Sintel</Text>}
            {clip && <Readability><View style={styles.file}>
              <Pressable accessibilityRole="button" accessibilityLabel={`Original filename: ${clip.name}. Show full filename.`} onPress={() => Alert.alert('Original filename', clip.name)} style={styles.filenameButton}><Text style={[styles.filename, { color: c.ink }]} numberOfLines={1} ellipsizeMode="middle">{clip.name}</Text><Icon name="info" color={c.secondary} size={17} /></Pressable>
              <Text style={[styles.metadata, { color: c.secondary }]}>{stage.kind === 'review' && stage.clip.inspecting ? 'Reading video details…' : mediaLine(clip)}</Text>
              {assurance && <Text style={[styles.assurance, { color: c.secondary }]}>{assurance}</Text>}
            </View></Readability>}
            {showStatus && <Readability><View style={styles.status}>
              <Progress stage={stage} theme={photoTheme} reducedMotion={reducedMotion} compact={compact} />
              {copy.label && <View style={styles.statusLabel}>
                {received && <Icon name="check" color={c.ink} size={22} />}
                {(stage.kind === 'preparing' || (stage.kind === 'saved' && stage.snapshot.kind === 'verifying')) && <ActivityIndicator size="small" color={c.ink} />}
                <Text accessibilityLiveRegion="polite" style={[styles.label, { color: copy.tone === 'error' ? c.error : c.ink }]}>{copy.label}</Text>
              </View>}
              {statusBody && <Text style={[styles.support, { color: c.secondary }]}>{statusBody}</Text>}
              {received && <View style={styles.receipt}>
                <Pressable onPress={() => setDetailsOpen(value => !value)} accessibilityRole="button" accessibilityLabel="Verification details" accessibilityState={{ expanded: detailsOpen }} style={styles.receiptToggle}><Text style={[styles.small, { color: c.secondary }]}>Receipt</Text><Text style={[styles.receiptId, { color: c.ink }]}>{received.receipt.id.slice(0, 8).toUpperCase()} · {detailsOpen ? 'Hide details' : 'View details'}</Text></Pressable>
                {detailsOpen && <>
                  <Text selectable style={[styles.hash, { color: c.secondary }]}>Receipt {received.receipt.id}</Text>
                  <Text selectable style={[styles.hash, { color: c.secondary }]}>SHA-256 {received.receipt.sha256}</Text>
                  <Text style={[styles.metadata, { color: c.secondary }]}>{new Date(received.receipt.verifiedAt).toLocaleString()}</Text>
                  <Pressable onPress={() => { void flow.view(true); }} disabled={flow.busy} accessibilityRole="button" style={styles.share}><Text style={[styles.small, { color: c.ink }]}>Share viewing link</Text><Icon name="arrow" color={c.secondary} size={16} /></Pressable>
                  <Text style={[styles.small, { color: c.secondary }]}>One use. Expires in 2 minutes. Anyone with the link can open it.</Text>
                </>}
              </View>}
            </View></Readability>}
            {flow.error && <Readability><View style={styles.error}><Text accessibilityRole="alert" style={[styles.support, { color: c.error, flex: 1 }]}>{flow.error}</Text><Pressable accessibilityRole="button" accessibilityLabel="Dismiss error" onPress={flow.dismissError} style={styles.iconButton}><Icon name="close" color={c.error} size={20} /></Pressable></View></Readability>}
          </ScrollView>
        </SafeAreaView>
        <SafeAreaView edges={['bottom', 'left', 'right']} style={[styles.footer, { backgroundColor: theme.dark ? 'transparent' : theme.colors.ground }]}>
          <View style={styles.footerContent}>
            {flow.busy && <ActivityIndicator color={theme.colors.ink} size="small" accessibilityLabel="Completing your request" />}
            {copy.primary && <Action theme={theme} label={copy.primary.label} primary upload={copy.primary.command === 'upload'} disabled={flow.busy || blockedUpload} onPress={() => { if (copy.primary) perform(copy.primary.command); }} />}
            {copy.secondary && <Action theme={theme} label={copy.secondary.label} primary={false} upload={false} disabled={flow.busy} onPress={() => { if (copy.secondary) perform(copy.secondary.command); }} />}
          </View>
        </SafeAreaView>
      </>}
    </Preview>
    {settingsOpen && <SettingsSheet visible settings={flow.settings} theme={theme} reducedMotion={reducedMotion} onClose={() => setSettingsOpen(false)} onSave={flow.saveSettings} />}
  </View>;
}

const styles = StyleSheet.create({
  safe: { flex: 1 }, scroll: { flex: 1 }, content: { flexGrow: 1, width: '100%', maxWidth: 560, alignSelf: 'center', paddingHorizontal: 24, paddingTop: 4, paddingBottom: 12, gap: 16 },
  brand: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', minHeight: 48 },
  wordmark: { fontSize: 28, lineHeight: 34, letterSpacing: -.6 },
  iconButton: { minWidth: 48, minHeight: 48, alignItems: 'center', justifyContent: 'center' },
  settingsButton: { borderRadius: 24, backgroundColor: '#1b1a188c', borderWidth: .5, borderColor: '#f4f1e92a' },
  title: { fontSize: 49, lineHeight: 53, letterSpacing: -1 }, compactTitle: { fontSize: 43, lineHeight: 47 },
  hero: { flexGrow: 1, alignItems: 'center', justifyContent: 'center', width: '100%' },
  playback: { alignItems: 'center', gap: 12 }, play: { width: 58, height: 58, borderRadius: 29, backgroundColor: '#151912d9', borderWidth: 1, borderColor: '#f4f1e970', alignItems: 'center', justifyContent: 'center' },
  playLabel: { fontSize: 13, lineHeight: 21, backgroundColor: '#0b0b0be8', paddingHorizontal: 9, paddingVertical: 4, borderRadius: 6 },
  unavailable: { width: '100%' }, fallbackRow: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  file: { gap: 4 }, filenameButton: { minHeight: 44, flexDirection: 'row', gap: 10, alignItems: 'center' },
  filename: { fontSize: 15, lineHeight: 22, fontWeight: '600', flex: 1 }, metadata: { fontSize: 13, lineHeight: 21 }, assurance: { fontSize: 13, lineHeight: 21, marginTop: 4 },
  small: { fontSize: 13, lineHeight: 21 },
  status: { gap: 8 }, statusLabel: { flexDirection: 'row', alignItems: 'center', gap: 10 }, label: { fontSize: 16, lineHeight: 23, fontWeight: '500', flexShrink: 1 }, support: { fontSize: 14, lineHeight: 22 },
  progressSection: { gap: 8, marginBottom: 12 }, percentage: { flexDirection: 'row', alignItems: 'baseline', gap: 3 },
  number: { fontSize: 72, lineHeight: 80, fontWeight: '300', letterSpacing: -3, fontVariant: ['tabular-nums'] }, compactNumber: { fontSize: 60, lineHeight: 68 }, unit: { fontSize: 28 }, byteCount: { fontSize: 13, lineHeight: 21, fontVariant: ['tabular-nums'] }, track: { height: 3, borderRadius: 2, overflow: 'hidden', marginTop: 2 },
  receipt: { gap: 4 }, receiptToggle: { minHeight: 48, flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', gap: 12, flexWrap: 'wrap' }, receiptId: { fontSize: 13, lineHeight: 21 }, hash: { fontSize: 13, lineHeight: 21 }, share: { minHeight: 48, flexDirection: 'row', alignItems: 'center', gap: 12 },
  error: { flexDirection: 'row', gap: 8, alignItems: 'center' },
  footer: { paddingHorizontal: 24, paddingTop: 10, paddingBottom: 6 }, footerContent: { width: '100%', maxWidth: 512, alignSelf: 'center', gap: 4 },
  action: { minHeight: 54, padding: 15, borderRadius: 28, flexDirection: 'row', gap: 9, alignItems: 'center', justifyContent: 'center' }, actionText: { fontSize: 17, lineHeight: 24, textAlign: 'center', flexShrink: 1 },
});
