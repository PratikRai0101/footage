import { useCallback, useEffect, useRef, useState } from 'react';
import { AppState, Linking, PermissionsAndroid, Platform, Share } from 'react-native';
import * as DocumentPicker from 'expo-document-picker';
import * as Haptics from 'expo-haptics';
import { transfers } from '../../../modules/footage-transfer/src/FootageTransferModule';
import { unknownMedia, type Connection, type Handoff, type Device, type MediaInfo, type Settings, type Snapshot } from '../../../modules/footage-transfer/src/contracts';
import { canChoose, type Draft } from './presentation';

const initialSettings: Settings = { origin: process.env.EXPO_PUBLIC_RECEIVER_ORIGIN ?? '', appearance: 'dark' };
const explain = (error: unknown) => {
  if (!(error instanceof Error)) return 'The operation could not finish. Try again.';
  const cause = error.message.split('Caused by:').pop()?.trim() ?? error.message;
  return cause.replace(/^(?:java|kotlin)\.[\w.]+:\s*/, '');
};
async function notificationPermission() {
  if (Platform.OS === 'android' && Number(Platform.Version) >= 33 && !await PermissionsAndroid.check(PermissionsAndroid.PERMISSIONS.POST_NOTIFICATIONS)) {
    await PermissionsAndroid.request(PermissionsAndroid.PERMISSIONS.POST_NOTIFICATIONS);
  }
}

export function useTransfer() {
  const [snapshot, setSnapshot] = useState<Snapshot>({ kind: 'empty' });
  const [connection, setConnection] = useState<Connection | null>(null);
  const [handoffRecord, setHandoffRecord] = useState<{ id: string; value: Handoff } | null>(null);
  const [device, setDevice] = useState<Device | null>(null);
  const [settings, setSettings] = useState(initialSettings);
  const [draft, setDraft] = useState<Draft>({ kind: 'none' });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const command = useRef(false);
  const autoStart = useRef(false);
  const selectionKey = useRef(0);
  const previous = useRef<Snapshot | null>(null);

  const act = useCallback(async (operation: () => Promise<void>) => {
    if (command.current) return;
    command.current = true;
    setBusy(true);
    setError(null);
    try { await operation(); }
    catch (failure) { const message = explain(failure); if (message !== 'Cancelled. Nothing was sent.') setError(message); }
    finally { command.current = false; setBusy(false); }
  }, []);

  const start = useCallback(async () => {
    await notificationPermission();
    await transfers.start();
  }, []);

  useEffect(() => {
    if (!transfers.available) return;
    let mounted = true;
    let reading = false;
    const read = async () => {
      if (reading || AppState.currentState !== 'active') return;
      reading = true;
      try {
        const value = await transfers.current();
        if (!mounted) return;
        if (value.kind === 'received' && previous.current !== null && previous.current.kind !== 'received') {
          void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => {});
        }
        if (JSON.stringify(value) !== JSON.stringify(previous.current)) setSnapshot(value);
        previous.current = value;
      } catch {
        if (mounted) setError('Could not read the saved transfer. Unlock the phone and reopen Footage.');
      } finally { reading = false; }
    };
    void Promise.all([transfers.device(), transfers.settings(), transfers.connection()]).then(([device, saved, connected]) => {
      if (mounted) {
        setDevice(device); setConnection(connected);
        setSettings({ ...saved, origin: saved.origin || initialSettings.origin });
      }
    }).catch(() => { if (mounted) setError('Could not open the native connection. Install the latest Footage build and try again.'); });
    void read();
    const timer = setInterval(() => { void read(); }, 750);
    const listener = AppState.addEventListener('change', state => {
      if (state !== 'active') autoStart.current = false;
      else void read();
    });
    return () => { mounted = false; clearInterval(timer); listener.remove(); };
  }, []);

  useEffect(() => {
    if (snapshot.kind !== 'ready' || !autoStart.current || AppState.currentState !== 'active') return;
    autoStart.current = false;
    void act(start);
  }, [snapshot, act, start]);

  const receivedId = snapshot.kind === 'received' ? snapshot.id : null;
  const handoff = receivedId && handoffRecord?.id === receivedId ? handoffRecord.value : null;
  useEffect(() => {
    if (!receivedId || !connection) return;
    let mounted = true, reading = false;
    const read = async () => {
      if (reading || AppState.currentState !== 'active') return;
      reading = true;
      try { const value = await transfers.handoff('status'); if (mounted) setHandoffRecord({ id: receivedId, value }); }
      catch { /* A failed read cannot invent or revoke a send acknowledgment. */ }
      finally { reading = false; }
    };
    void read(); const timer = setInterval(() => { void read(); }, 5000);
    return () => { mounted = false; clearInterval(timer); };
  }, [receivedId, connection]);

  const choose = () => act(async () => {
    if (!canChoose(snapshot)) throw new Error('Finish this transfer or confirm its cancellation first.');
    const asset = await (async () => {
      if (Platform.OS === 'ios' && transfers.available) return transfers.pickOriginal();
      const result = await DocumentPicker.getDocumentAsync({ type: 'video/*', multiple: false, copyToCacheDirectory: false, base64: false });
      return result.canceled ? null : result.assets[0];
    })();
    if (!asset) return;
    const key = ++selectionKey.current;
    const clip = { key, uri: asset.uri, name: asset.name, bytes: asset.size && asset.size > 0 ? asset.size : null, media: unknownMedia, inspecting: transfers.available };
    setDraft({ kind: 'review', clip });
    if (transfers.available) {
      void transfers.inspect(asset.uri).catch(() => unknownMedia).then(media => {
        setDraft(current => current.kind !== 'none' && current.clip.key === key
          ? { ...current, clip: { ...current.clip, media, inspecting: false } } : current);
      });
    }
  });

  const recordPreviewMetadata = useCallback((uri: string, media: MediaInfo) => {
    if (transfers.available) return;
    setDraft(current => {
      if (current.kind !== 'review' || current.clip.uri !== uri) return current;
      const previous = current.clip.media;
      const next = {
        durationMs: media.durationMs ?? previous.durationMs,
        width: media.width ?? previous.width,
        height: media.height ?? previous.height,
        mimeType: media.mimeType ?? previous.mimeType,
      };
      if (JSON.stringify(previous) === JSON.stringify(next)) return current;
      return { ...current, clip: { ...current.clip, media: next, inspecting: false } };
    });
  }, []);

  const upload = () => act(async () => {
    if (draft.kind !== 'review') return;
    if (!settings.origin.trim()) throw new Error('Connect your computer in Settings before uploading.');
    await notificationPermission();
    await transfers.prepare(draft.clip.uri, draft.clip.name, settings.origin);
    autoStart.current = AppState.currentState === 'active';
    setDraft({ kind: 'submitted', clip: draft.clip, previousId: 'id' in snapshot ? snapshot.id : null });
    setSnapshot(await transfers.current());
  });

  const cancel = () => act(async () => {
    autoStart.current = false;
    await transfers.cancel();
    setSnapshot(await transfers.current());
  });

  const saveSettings = async (value: Settings) => {
    if (transfers.available) {
      await transfers.configure(value);
      setSettings(await transfers.settings());
      return;
    }
    if (value.origin.trim()) {
      const url = new URL(value.origin.trim());
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash || url.pathname !== '/') {
        throw new Error('Enter only the HTTP or HTTPS receiver origin.');
      }
    }
    setSettings({ ...value, origin: value.origin.trim().replace(/\/$/, '') });
  };

  const connect = async () => {
    const result = await DocumentPicker.getDocumentAsync({ type: '*/*', multiple: false, copyToCacheDirectory: false, base64: false });
    if (result.canceled || !result.assets[0]) return;
    setConnection(await transfers.connect(result.assets[0].uri));
    const [saved, nextDevice] = await Promise.all([transfers.settings(), transfers.device()]);
    setSettings(saved); setDevice(nextDevice);
    return saved;
  };

  const selectDestination = async () => {
    const selected = await transfers.selectDestination(); setConnection(selected);
    setSnapshot(await transfers.current()); return selected;
  };
  const handoffCommand = (operation: 'send' | 'deliver') => act(async () => {
    if (!receivedId) throw new Error('Wait for a verified original.');
    try { const value = await transfers.handoff(operation); setHandoffRecord({ id: receivedId, value }); }
    catch (failure) {
      if (explain(failure) === 'Cancelled. Nothing was sent.') return;
      throw new Error(operation === 'send' ? 'Send not confirmed. Reconnect and retry this original; do not upload it again.' : 'Could not confirm workspace delivery. Check your computer and try again.');
    }
  });
  const send = () => handoffCommand('send');
  const deliver = () => handoffCommand('deliver');

  const view = (share = false) => act(async () => {
    try {
      if (!share && (Platform.OS === 'ios' || connection !== null)) { await transfers.openViewer(); return; }
      const url = await transfers.viewer();
      if (share) await Share.share({ title: 'Footage original', message: url });
      else await Linking.openURL(url);
    } catch {
      // Browser errors can contain the one-use link. Never surface that capability.
      throw new Error('Could not open the private viewing link. Check the receiver connection, then try again.');
    }
  });

  return { snapshot, device, connection, handoff, settings, draft, error, busy, available: transfers.available && (Platform.OS !== 'ios' || device?.supportsTransfer === true),
    choose, upload, cancel, connect, selectDestination, send, deliver, recordPreviewMetadata, resume: () => act(start), view, saveSettings,
    dismissError: () => setError(null) };
}
