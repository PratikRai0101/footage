import Svg, { Path, Rect } from 'react-native-svg';

export function Icon({ name, color, size = 24 }: { name: 'settings' | 'check' | 'close' | 'arrow' | 'film' | 'play'; color: string; size?: number }) {
  return <Svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round" accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
    {name === 'settings' && <><Path d="M4 7h16M4 17h16" /><Rect x={7} y={4} width={4} height={6} rx={1.5} fill={color} stroke="none" /><Rect x={14} y={14} width={4} height={6} rx={1.5} fill={color} stroke="none" /></>}
    {name === 'play' && <Path d="m9 5 11 7-11 7z" fill={color} stroke="none" />}
    {name === 'check' && <Path d="m4 12 5 5L20 6" />}
    {name === 'close' && <Path d="m6 6 12 12M6 18 18 6" />}
    {name === 'arrow' && <Path d="M5 12h14m-5-5 5 5-5 5" />}
    {name === 'film' && <><Rect x={4} y={3} width={16} height={18} rx={3} /><Path d="M4 7h3m-3 5h3m-3 5h3M17 7h3m-3 5h3m-3 5h3M10 9l5 3-5 3z" /></>}
  </Svg>;
}
