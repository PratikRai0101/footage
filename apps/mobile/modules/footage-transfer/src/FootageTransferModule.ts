import { NativeModule, requireOptionalNativeModule } from 'expo';
import { Platform } from 'react-native';
import { deviceSchema, mediaSchema, settingsSchema, snapshotSchema, type Device, type MediaInfo, type Settings, type Snapshot } from './contracts';

declare class FootageTransferModule extends NativeModule {
  device(): Promise<string>;
  current(): Promise<string>;
  inspect(uri: string): Promise<string>;
  settings(): Promise<string>;
  configure(origin: string, appearance: Settings['appearance']): Promise<void>;
  viewer(): Promise<string>;
  prepare(uri: string, name: string, endpoint: string): Promise<void>;
  start(): Promise<void>;
  cancel(): Promise<void>;
}

const native = Platform.OS === 'android' || Platform.OS === 'ios' ? requireOptionalNativeModule<FootageTransferModule>('FootageTransfer') : null;
function owner(): FootageTransferModule {
  if (!native) throw new Error('Original transfer requires a native Footage build. Web can preview only.');
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
  prepare: (uri: string, name: string, endpoint: string) => owner().prepare(uri, name, endpoint),
  start: () => owner().start(),
  cancel: () => owner().cancel(),
};
