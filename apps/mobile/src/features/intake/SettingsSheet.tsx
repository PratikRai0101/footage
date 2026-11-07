import { useState } from 'react';
import { ActivityIndicator, KeyboardAvoidingView, Modal, Platform, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import type { Settings } from '../../../modules/footage-transfer/src/contracts';
import { Icon } from './Icon';
import { licenses } from './licenses';
import type { Theme } from './theme';

export function SettingsSheet({ visible, settings, theme, reducedMotion, onClose, onSave, onConnect }: {
  visible: boolean; settings: Settings; theme: Theme; reducedMotion: boolean; onClose: () => void; onSave: (value: Settings) => Promise<void>; onConnect: () => Promise<Settings | undefined>;
}) {
  const [origin, setOrigin] = useState(settings.origin);
  const [appearance, setAppearance] = useState(settings.appearance);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [aboutVisible, setAboutVisible] = useState(false);
  const [creditsVisible, setCreditsVisible] = useState(false);
  const c = theme.colors;
  async function save() {
    if (saving) return;
    setSaving(true); setError(null);
    try { await onSave({ origin, appearance }); onClose(); }
    catch (error) { setError(error instanceof Error ? error.message : 'Could not save settings.'); }
    finally { setSaving(false); }
  }
  return <Modal visible={visible} transparent animationType={reducedMotion ? 'none' : 'fade'} onRequestClose={onClose}>
    <KeyboardAvoidingView style={styles.overlay} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <Pressable style={StyleSheet.absoluteFill} onPress={onClose} accessibilityLabel="Dismiss settings" />
      <SafeAreaView edges={['bottom']} style={[styles.sheet, { backgroundColor: c.ground, borderColor: c.rule }]} accessibilityViewIsModal>
        <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={styles.content}>
          <View style={styles.header}><Text accessibilityRole="header" style={[styles.title, { color: c.ink, fontFamily: theme.display }]}>Settings</Text><Pressable onPress={onClose} style={styles.iconButton} accessibilityRole="button" accessibilityLabel="Close settings"><Icon name="close" color={c.ink} /></Pressable></View>
          <Text style={[styles.label, { color: c.ink }]}>{Platform.OS === 'ios' ? 'Computer' : 'Upload destination'}</Text>
          {Platform.OS === 'ios' ? <>
            {origin && <Text selectable style={[styles.body, { color: c.ink }]}>{origin}</Text>}
            <Pressable disabled={saving} accessibilityRole="button" onPress={() => {
              setSaving(true); setError(null);
              void onConnect().then(saved => { if (saved) setOrigin(saved.origin); }).catch(error => setError(error instanceof Error ? error.message : 'Could not connect.')).finally(() => setSaving(false));
            }} style={[styles.input, { borderColor: c.secondary, backgroundColor: c.raised }]}><Text style={[styles.body, { color: c.ink }]}>{origin ? 'Change connection' : 'Connect computer'}</Text></Pressable>
            <Text style={[styles.note, { color: c.secondary }]}>Open the connection file exported by your computer. Originals go to the destination you confirm.</Text>
          </> : <>
            <TextInput accessibilityLabel="Server address" value={origin} onChangeText={setOrigin} editable={!saving} autoCapitalize="none" autoCorrect={false} keyboardType="url" placeholder="http://192.168.1.10:1080" placeholderTextColor={c.secondary} style={[styles.input, { color: c.ink, borderColor: c.secondary, backgroundColor: c.raised }]} returnKeyType="done" onSubmitEditing={() => { void save(); }} />
            <Text style={[styles.note, { color: c.secondary }]}>Changes apply to the next upload.</Text>
          </>}
          <Text style={[styles.label, { color: c.ink }]}>Appearance</Text>
          <View style={styles.appearances} accessibilityRole="radiogroup">
            {([{ value: 'dark', label: 'Dark' }, { value: 'light', label: 'Light' }, { value: 'system', label: 'System' }] satisfies { value: Settings['appearance']; label: string }[]).map(option => <Pressable key={option.value} onPress={() => setAppearance(option.value)} accessibilityRole="radio" accessibilityState={{ checked: appearance === option.value }} style={[styles.appearance, { borderColor: appearance === option.value ? c.ink : c.rule, backgroundColor: appearance === option.value ? c.raised : c.ground }]}><Text style={{ color: c.ink, fontSize: 14 }}>{option.label}</Text></Pressable>)}
          </View>
          {error && <Text accessibilityRole="alert" style={[styles.body, { color: c.error }]}>{error}</Text>}
          <Pressable disabled={saving} onPress={() => { void save(); }} accessibilityRole="button" accessibilityLabel="Done" style={({ pressed }) => [styles.done, { backgroundColor: c.action, opacity: pressed || saving ? .65 : 1 }]}>{saving ? <ActivityIndicator color={c.onAction} /> : <Text style={[styles.doneText, { color: c.onAction }]}>Done</Text>}</Pressable>
          <Pressable onPress={() => setAboutVisible(value => !value)} accessibilityRole="button" accessibilityState={{ expanded: aboutVisible }} style={styles.about}><Text style={[styles.body, { color: c.secondary }]}>About Footage</Text><Icon name="arrow" color={c.secondary} size={16} /></Pressable>
          {aboutVisible && <>
            <Text style={[styles.note, { color: c.secondary }]}>An independent prototype. Not an official Cardboard app or integration.</Text>
            <Text style={[styles.note, { color: c.secondary }]}>Android and connected iPhone builds upload originals. Web supports local preview. System pickers may create temporary copies. Keep Footage open during preparation; the system can continue a prepared upload in the background. Reopen after force-quit to resume.</Text>
            <Text style={[styles.note, { color: c.secondary }]}>Use a trusted private network for local HTTP. Background behavior depends on Android, network and power settings. Notifications depend on permission.</Text>
            <Pressable onPress={() => setCreditsVisible(value => !value)} accessibilityRole="button" accessibilityState={{ expanded: creditsVisible }} style={styles.iconButton}><Text style={[styles.note, { color: c.ink }]}>Licenses and sample credit</Text></Pressable>
            {creditsVisible && <Text selectable style={[styles.note, { color: c.secondary }]}>{licenses}</Text>}
          </>}
        </ScrollView>
      </SafeAreaView>
    </KeyboardAvoidingView>
  </Modal>;
}

const styles = StyleSheet.create({
  overlay: { flex: 1, justifyContent: 'flex-end', backgroundColor: '#00000088' },
  sheet: { maxHeight: '92%', borderTopLeftRadius: 28, borderTopRightRadius: 28, borderWidth: StyleSheet.hairlineWidth },
  content: { padding: 24, paddingBottom: 28, gap: 16, width: '100%', maxWidth: 560, alignSelf: 'center' },
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 12 },
  title: { fontSize: 32, lineHeight: 38, flex: 1 }, iconButton: { minWidth: 48, minHeight: 48, justifyContent: 'center', alignItems: 'center' },
  body: { fontSize: 15, lineHeight: 23 }, label: { fontSize: 14, fontWeight: '600', marginTop: 8 },
  input: { minHeight: 56, borderWidth: 1, borderRadius: 12, padding: 16, fontSize: 16 },
  note: { fontSize: 12, lineHeight: 19 }, appearances: { flexDirection: 'row', gap: 8, flexWrap: 'wrap' },
  appearance: { flex: 1, minWidth: 72, minHeight: 48, borderWidth: 1, borderRadius: 12, alignItems: 'center', justifyContent: 'center', padding: 10 },
  done: { minHeight: 54, borderRadius: 16, justifyContent: 'center', alignItems: 'center', padding: 16, marginTop: 8 },
  doneText: { fontSize: 16, fontWeight: '600' },
  about: { minHeight: 48, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
});
