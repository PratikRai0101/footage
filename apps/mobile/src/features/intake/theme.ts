import { Platform, useColorScheme } from 'react-native';
import { useFonts } from 'expo-font';
import type { Settings } from '../../../modules/footage-transfer/src/contracts';

const dark = { ground: '#0b0b0b', raised: '#1b1a18', ink: '#f4f1e9', secondary: '#b8b2a9', rule: '#3b3833', action: '#f4f1e9', onAction: '#161615', warning: '#e9bd85', error: '#f3b3aa' };
const light = { ground: '#f4f1e9', raised: '#e8e3d9', ink: '#161615', secondary: '#5e594f', rule: '#c7c0b3', action: '#161615', onAction: '#f4f1e9', warning: '#80520b', error: '#9b3030' };
export type Theme = { colors: typeof dark; photo: typeof dark; dark: boolean; display: string };

export function useScreeningTheme(appearance: Settings['appearance']): Theme {
  const system = useColorScheme();
  const isDark = appearance === 'dark' || (appearance === 'system' && system !== 'light');
  const [loaded] = useFonts({ FootageDisplay: require('../../../assets/fonts/InstrumentSerif-Regular.ttf') });
  return { colors: isDark ? dark : light, photo: dark, dark: isDark, display: loaded ? 'FootageDisplay' : Platform.OS === 'android' ? 'serif' : 'Georgia' };
}
