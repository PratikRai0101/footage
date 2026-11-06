import { Platform, useColorScheme } from 'react-native';
import { useFonts } from 'expo-font';
import type { Settings } from '../../../modules/footage-transfer/src/contracts';

const dark = { ground: '#0b0c0d', raised: '#202123', ink: '#f5f4f0', secondary: '#acadb0', rule: '#393a3d', action: '#f5f4f0', onAction: '#101112', warning: '#e9bd85', error: '#f3b3aa' };
const light = { ground: '#f4f6f7', raised: '#e9edf0', ink: '#171e24', secondary: '#535e67', rule: '#c7cfd5', action: '#171e24', onAction: '#ffffff', warning: '#80520b', error: '#9b3030' };
export type Theme = { colors: typeof dark; dark: boolean; display: string };

export function useScreeningTheme(appearance: Settings['appearance']): Theme {
  const system = useColorScheme();
  const isDark = appearance === 'dark' || (appearance === 'system' && system !== 'light');
  const [loaded] = useFonts({ FootageDisplay: require('../../../assets/fonts/InstrumentSerif-Regular.ttf') });
  return { colors: isDark ? dark : light, dark: isDark, display: loaded ? 'FootageDisplay' : Platform.OS === 'android' ? 'serif' : 'Georgia' };
}
