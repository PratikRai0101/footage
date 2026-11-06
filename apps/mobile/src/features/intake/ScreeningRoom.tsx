import { useEffect, useState } from 'react';
import { AccessibilityInfo, ActivityIndicator, Alert, Animated, Easing, Pressable, ScrollView, StyleSheet, Text, useWindowDimensions, useAnimatedValue, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { StatusBar } from 'expo-status-bar';
import { copyFor, formatBytes, fractionFor, mediaLine, present, type Command, type Stage } from './presentation';
import { useTransfer } from './useTransfer';
import { useScreeningTheme, type Theme } from './theme';
import { Preview } from './Preview';
import { Icon } from './Icon';
import { SettingsSheet } from './SettingsSheet';

function Progress({ stage, theme, reducedMotion }: { stage: Stage; theme: Theme; reducedMotion: boolean }) {
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
    <View style={styles.progressNumbers}>
      <View style={styles.percentage}><Text style={[styles.number, { color: theme.colors.ink }]}>{fraction === null ? '—' : Math.floor(fraction * 100)}</Text>{fraction !== null && <Text style={[styles.unit, { color: theme.colors.secondary }]}>%</Text>}</View>
      <Text style={[styles.byteCount, { color: theme.colors.secondary }]}>{caption}</Text>
    </View>
    <View accessibilityRole="progressbar" accessibilityLabel={caption} accessibilityValue={fraction === null ? { text: caption } : { min: 0, max: 100, now: Math.floor(fraction * 100) }} style={[styles.track, { backgroundColor: theme.colors.rule }]}>
      <Animated.View style={[StyleSheet.absoluteFill, { backgroundColor: theme.colors.ink, transform: [{ scaleX: motion }], transformOrigin: 'left center' }]} />
    </View>
  </View>;
}

function Action({ label, primary, disabled, onPress, theme }: { label: string; primary: boolean; disabled: boolean; onPress: () => void; theme: Theme }) {
  return <Pressable onPress={onPress} disabled={disabled} accessibilityRole="button" accessibilityLabel={label} accessibilityState={{ disabled }} style={({ pressed }) => [styles.action, { backgroundColor: primary ? theme.colors.action : 'transparent', borderColor: primary ? theme.colors.action : 'transparent', opacity: pressed || disabled ? .55 : 1 }]}><Text style={[styles.actionText, { color: primary ? theme.colors.onAction : theme.colors.secondary, fontWeight: primary ? '600' : '400' }]}>{label}</Text></Pressable>;
}

export function ScreeningRoom() {
  const flow = useTransfer();
  const theme = useScreeningTheme(flow.settings.appearance);
  const c = theme.colors;
  const dimensions = useWindowDimensions();
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
  const previewHeight = stage.kind === 'import' ? Math.max(240, Math.min(380, dimensions.height * .43)) : Math.max(190, Math.min(280, dimensions.height * .28));
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

  return <SafeAreaView style={[styles.safe, { backgroundColor: c.ground }]}>
    <StatusBar style={theme.dark ? 'light' : 'dark'} />
    <ScrollView style={styles.scroll} contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
      <View style={styles.brand}>
        <Text style={[styles.wordmark, { color: c.ink, fontFamily: theme.display }]}>Footage</Text>
        <Pressable onPress={() => setSettingsOpen(true)} accessibilityRole="button" accessibilityLabel="Settings" style={styles.iconButton}><Icon name="settings" color={c.ink} size={22} /></Pressable>
      </View>
      <Text accessibilityRole="header" style={[styles.title, { color: c.ink, fontFamily: theme.display, minHeight: 76 }]}>{copy.title}</Text>
      <Preview theme={theme} height={previewHeight} sample={stage.kind === 'import'} uri={clip && playable ? clip.uri : null} interactive={stage.kind === 'review' || received !== null} onMetadata={flow.available ? undefined : flow.recordPreviewMetadata} />
      {clip && <View style={styles.file}>
        <Pressable accessibilityRole="button" accessibilityLabel={`Original filename: ${clip.name}. Show full filename.`} onPress={() => Alert.alert('Original filename', clip.name)} style={styles.filenameButton}><Text style={[styles.filename, { color: c.ink }]} numberOfLines={1} ellipsizeMode="middle">{clip.name}</Text></Pressable>
        <Text style={[styles.metadata, { color: c.secondary }]}>{stage.kind === 'review' && stage.clip.inspecting ? 'Reading video details…' : mediaLine(clip)}</Text>
      </View>}
      <View style={[styles.status, { borderColor: c.rule }]}>
        <Progress stage={stage} theme={theme} reducedMotion={reducedMotion} />
        {copy.label && <View style={styles.statusLabel}>
          {received && <Icon name="check" color={c.ink} size={22} />}
          {(stage.kind === 'preparing' || (stage.kind === 'saved' && stage.snapshot.kind === 'verifying')) && <ActivityIndicator size="small" color={c.ink} />}
          <Text accessibilityLiveRegion="polite" style={[styles.label, { color: copy.tone === 'warning' ? c.warning : copy.tone === 'error' ? c.error : c.ink }]}>{copy.label}</Text>
        </View>}
        {copy.body && <Text style={[styles.support, { color: c.secondary }]}>{copy.body}</Text>}
      {received && <View style={[styles.receipt, { borderColor: c.rule }]}>
        <Pressable onPress={() => setDetailsOpen(value => !value)} accessibilityRole="button" accessibilityLabel="Verification details" accessibilityState={{ expanded: detailsOpen }} style={styles.receiptToggle}><Text style={[styles.small, { color: c.secondary }]}>Receipt</Text><Text style={[styles.receiptId, { color: c.ink }]}>{received.receipt.id.slice(0, 8).toUpperCase()} · {detailsOpen ? 'Hide details' : 'View details'}</Text></Pressable>
        {detailsOpen && <>
          <Text selectable style={[styles.hash, { color: c.secondary }]}>Receipt {received.receipt.id}</Text>
          <Text selectable style={[styles.hash, { color: c.secondary }]}>SHA-256 {received.receipt.sha256}</Text>
          <Text style={[styles.metadata, { color: c.secondary }]}>{new Date(received.receipt.verifiedAt).toLocaleString()}</Text>
          <Pressable onPress={() => { void flow.view(true); }} disabled={flow.busy} accessibilityRole="button" style={styles.share}><Text style={[styles.small, { color: c.ink }]}>Share viewing link</Text><Icon name="arrow" color={c.secondary} size={16} /></Pressable>
          <Text style={[styles.small, { color: c.secondary }]}>One use. Expires in 2 minutes. Anyone with the link can open it.</Text>
        </>}
      </View>}
      </View>
      {flow.error && <View style={[styles.error, { borderColor: c.rule }]}><Text accessibilityRole="alert" style={[styles.support, { color: c.error, flex: 1 }]}>{flow.error}</Text><Pressable accessibilityRole="button" accessibilityLabel="Dismiss error" onPress={flow.dismissError} style={styles.iconButton}><Icon name="close" color={c.error} size={20} /></Pressable></View>}
    </ScrollView>
    <View style={[styles.footer, { borderColor: c.rule, backgroundColor: c.ground }]}>
      <View style={styles.footerContent}>
        {flow.busy && <ActivityIndicator color={c.ink} size="small" accessibilityLabel="Completing your request" />}
        {copy.primary && <Action theme={theme} label={copy.primary.label} primary disabled={flow.busy || blockedUpload} onPress={() => { if (copy.primary) perform(copy.primary.command); }} />}
        {copy.secondary && <Action theme={theme} label={copy.secondary.label} primary={false} disabled={flow.busy} onPress={() => { if (copy.secondary) perform(copy.secondary.command); }} />}
      </View>
    </View>
    {settingsOpen && <SettingsSheet visible settings={flow.settings} theme={theme} reducedMotion={reducedMotion} onClose={() => setSettingsOpen(false)} onSave={flow.saveSettings} />}
  </SafeAreaView>;
}

const styles = StyleSheet.create({
  safe: { flex: 1 }, scroll: { flex: 1 }, content: { width: '100%', maxWidth: 560, alignSelf: 'center', paddingHorizontal: 24, paddingTop: 4, paddingBottom: 24, gap: 18 },
  brand: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', minHeight: 48 },
  wordmark: { fontSize: 24, lineHeight: 30 },
  iconButton: { minWidth: 48, minHeight: 48, alignItems: 'center', justifyContent: 'center' },
  title: { fontSize: 34, lineHeight: 39, letterSpacing: -.5 }, file: { gap: 5, minHeight: 60 }, filenameButton: { minHeight: 44, justifyContent: 'center' },
  filename: { fontSize: 17, lineHeight: 23, fontWeight: '600' }, metadata: { fontSize: 13, lineHeight: 21 },
  small: { fontSize: 13, lineHeight: 21 },
  status: { borderTopWidth: StyleSheet.hairlineWidth, paddingTop: 18, gap: 8 }, statusLabel: { flexDirection: 'row', alignItems: 'center', gap: 10 }, label: { fontSize: 16, lineHeight: 23, fontWeight: '500', flexShrink: 1 }, support: { fontSize: 14, lineHeight: 22 },
  progressSection: { gap: 16, marginBottom: 12 }, progressNumbers: { flexDirection: 'row', alignItems: 'baseline', flexWrap: 'wrap', justifyContent: 'space-between', gap: 12 }, percentage: { flexDirection: 'row', alignItems: 'baseline', gap: 3 },
  number: { fontSize: 60, lineHeight: 66, fontWeight: '300', letterSpacing: -2, fontVariant: ['tabular-nums'] }, unit: { fontSize: 17 }, byteCount: { fontSize: 12, lineHeight: 20, fontVariant: ['tabular-nums'], flexShrink: 1 }, track: { height: 4, borderRadius: 4, overflow: 'hidden' },
  receipt: { gap: 4 }, receiptToggle: { minHeight: 48, flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', gap: 12, flexWrap: 'wrap' }, receiptId: { fontSize: 13, lineHeight: 21 }, hash: { fontSize: 12, lineHeight: 20 }, share: { minHeight: 48, flexDirection: 'row', alignItems: 'center', gap: 12 },
  error: { borderTopWidth: StyleSheet.hairlineWidth, paddingTop: 12, flexDirection: 'row', gap: 8, alignItems: 'center' },
  footer: { borderTopWidth: StyleSheet.hairlineWidth, paddingHorizontal: 24, paddingTop: 14, paddingBottom: 6 }, footerContent: { width: '100%', maxWidth: 512, alignSelf: 'center', gap: 4 },
  action: { minHeight: 54, padding: 15, borderRadius: 16, borderWidth: 1, alignItems: 'center', justifyContent: 'center' }, actionText: { fontSize: 16, lineHeight: 24, textAlign: 'center' },
});
