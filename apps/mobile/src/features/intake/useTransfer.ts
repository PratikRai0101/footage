import { useCallback, useEffect, useRef, useState } from 'react';
import { AppState, Linking, PermissionsAndroid, Platform, Share } from 'react-native';
import * as DocumentPicker from 'expo-document-picker';
import * as Haptics from 'expo-haptics';
import { transfers } from '../../../modules/footage-transfer/src/FootageTransferModule';
import { unknownMedia, type Device, type MediaInfo, type Settings, type Snapshot } from '../../../modules/footage-transfer/src/contracts';
import { canChoose, type Draft } from './presentation';

const initialSettings: Settings = { origin: process.env.EXPO_PUBLIC_RECEIVER_ORIGIN ?? '', appearance: 'dark' };
const explain = (error: unknown) => {
  if (!(error instanceof Error)) return 'The operation could not finish. Try again.';
  const cause = error.message.split('Caused by:').pop()?.trim() ?? error.message;
  return cause.replace(/^java\.lang\.\w+:\s*/, '');
};
async function notificationPermission() {
  if (Platform.OS === 'android' && Number(Platform.Version) >= 33 && !await PermissionsAndroid.check(PermissionsAndroid.PERMISSIONS.POST_NOTIFICATIONS)) {
    await PermissionsAndroid.request(PermissionsAndroid.PERMISSIONS.POST_NOTIFICATIONS);
  }
}

export function useTransfer() {
  const [snapshot, setSnapshot] = useState<Snapshot>({ kind: 'empty' });
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
    catch (failure) { setError(explain(failure)); }
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
        if (mounted) setError('Could not read the saved transfer. Reopen Footage with the latest Android build.');
      } finally { reading = false; }
    };
    void Promise.all([transfers.device(), transfers.settings()]).then(([device, saved]) => {
      if (mounted) {
        setDevice(device);
        setSettings({ ...saved, origin: saved.origin || initialSettings.origin });
      }
    }).catch(() => { if (mounted) setError('Install the latest Android build to use the native transfer module.'); });
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

  const choose = () => act(async () => {
    if (!canChoose(snapshot)) throw new Error('Finish this transfer or confirm its cancellation first.');
    const result = await DocumentPicker.getDocumentAsync({ type: 'video/*', multiple: false, copyToCacheDirectory: false, base64: false });
    if (result.canceled) return;
    const asset = result.assets[0];
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
    if (!settings.origin.trim()) throw new Error('Connect your demo server before uploading. Open receiver settings above.');
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

  const view = (share = false) => act(async () => {
    try {
      const url = await transfers.viewer();
      if (share) await Share.share({ title: 'Footage original', message: url });
      else await Linking.openURL(url);
    } catch {
      // Browser errors can contain the one-use link. Never surface that capability.
      throw new Error('Could not open the private viewing link. Check the receiver connection, then try again.');
    }
  });

  return { snapshot, device, settings, draft, error, busy, available: transfers.available,
    choose, upload, cancel, recordPreviewMetadata, resume: () => act(start), view, saveSettings,
    dismissError: () => setError(null) };
}
