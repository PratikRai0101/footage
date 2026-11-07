import { NativeModule, requireOptionalNativeModule } from 'expo';
import { Platform } from 'react-native';
import { connectionSchema, deviceSchema, mediaSchema, settingsSchema, snapshotSchema, type Device, type MediaInfo, type Settings, type Snapshot } from './contracts';

declare class FootageTransferModule extends NativeModule {
  device(): Promise<string>;
  current(): Promise<string>;
  inspect(uri: string): Promise<string>;
  settings(): Promise<string>;
  configure(origin: string, appearance: Settings['appearance']): Promise<void>;
  viewer(): Promise<string>;
  openViewer(): Promise<void>;
  prepare(uri: string, name: string, endpoint: string): Promise<void>;
  start(): Promise<void>;
  cancel(): Promise<void>;
  connect(uri: string): Promise<string>;
}

const native = Platform.OS === 'android' || Platform.OS === 'ios' ? requireOptionalNativeModule<FootageTransferModule>('FootageTransfer') : null;
function owner(): FootageTransferModule {
  if (!native) throw new Error('Install the native Footage app to upload originals. Web supports local preview only.');
  return native;
}
function parseJson(input: string): unknown { return JSON.parse(input); }
export const transfers = {
  available: native !== null,
  async device(): Promise<Device> { return deviceSchema.parse(parseJson(await owner().device())); },
  async current(): Promise<Snapshot> { return snapshotSchema.parse(parseJson(await owner().current())); },
  async inspect(uri: string): Promise<MediaInfo> { return mediaSchema.parse(parseJson(await owner().inspect(uri))); },
  async settings(): Promise<Settings> { return settingsSchema.parse(parseJson(await owner().settings())); },
  configure: (settings: Settings) => owner().configure(settings.origin, settings.appearance),
  viewer: () => owner().viewer(),
  openViewer: () => owner().openViewer(),
  prepare: (uri: string, name: string, endpoint: string) => owner().prepare(uri, name, endpoint),
  start: () => owner().start(),
  cancel: () => owner().cancel(),
  async connect(uri: string) { return connectionSchema.parse(parseJson(await owner().connect(uri))); },
};
