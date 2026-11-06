import { useEffect } from 'react';
import { Platform } from 'react-native';
import { Stack } from 'expo-router';
import { setToolsButtonVisible } from 'expo-dev-menu';

export default function RootLayout() {
  useEffect(() => { if (__DEV__ && Platform.OS !== 'web') setToolsButtonVisible(false); }, []);
  return <Stack screenOptions={{ headerShown: false, contentStyle: { backgroundColor: '#0b0c0d' }, animation: 'none' }} />;
}
