'use strict';

export const DEFAULT_VISUAL_THEME_ID = 'browser-cpp-dark';

const DEFAULT_ANSI_COLORS = {
  black: foreground => foreground, red: '#c01c28', green: '#2d7d46', yellow: '#9a6700',
  blue: '#0969da', magenta: '#8250df', cyan: '#0a7b83', white: foreground => foreground,
  brightBlack: '#768390', brightRed: '#d1242f', brightGreen: '#1a7f37',
  brightYellow: '#bf8700', brightBlue: '#218bff', brightMagenta: '#a475f9',
  brightCyan: '#1b9aaa', brightWhite: foreground => foreground,
};

const terminal = (background, foreground, accent, selection, ansi = DEFAULT_ANSI_COLORS) => ({
  background, foreground, cursor: accent, cursorAccent: background,
  selectionForeground: selection.foreground,
  selectionBackground: selection.background,
  selectionInactiveBackground: selection.inactiveBackground,
  ...Object.fromEntries(Object.entries(ansi).map(([key, value]) => [
    key, typeof value === 'function' ? value(foreground) : value,
  ])),
});

const monochromeAnsi = (foreground, tertiary) => ({
  black: foreground, red: tertiary, green: tertiary, yellow: tertiary,
  blue: tertiary, magenta: tertiary, cyan: tertiary, white: foreground,
  brightBlack: tertiary, brightRed: foreground, brightGreen: foreground,
  brightYellow: foreground, brightBlue: foreground, brightMagenta: foreground,
  brightCyan: foreground, brightWhite: foreground,
});

const visualTheme = ({ id, label, monacoTheme, selection, cssTokens, terminalColors, preview }) => ({
  id,
  label,
  monacoTheme,
  selection,
  cssTokens,
  terminalTheme: terminal(
    terminalColors.background,
    terminalColors.foreground,
    terminalColors.accent,
    selection,
    terminalColors.ansi
  ),
  preview,
});

export const VISUAL_THEMES = Object.freeze([
  visualTheme({
    id: 'browser-cpp-dark', label: 'browser.cpp Dark', monacoTheme: 'browser-cpp-dark',
    selection: { foreground: '#cdd6f4', background: '#45475a', inactiveBackground: '#313244' },
    cssTokens: { crust: '#11111b', mantle: '#181825', base: '#1e1e2e', surface0: '#313244', surface1: '#45475a', overlay0: '#6c7086', text: '#cdd6f4', subtext0: '#a6adc8', green: '#a6e3a1', red: '#f38ba8', yellow: '#f9e2af', blue: '#89b4fa', mauve: '#cba6f7', peach: '#fab387' },
    terminalColors: { background: '#11111b', foreground: '#cdd6f4', accent: '#f5c2e7' }, preview: { background: '#1e1e2e', foreground: '#cdd6f4', accent: '#89b4fa' },
  }),
  visualTheme({
    id: 'vs', label: 'Light', monacoTheme: 'browser-cpp-vs',
    selection: { foreground: '#ffffff', background: '#0969da', inactiveBackground: '#0550ae' },
    cssTokens: { crust: '#f6f8fa', mantle: '#ffffff', base: '#ffffff', surface0: '#d0d7de', surface1: '#afb8c1', overlay0: '#57606a', text: '#1f2328', subtext0: '#57606a', green: '#1a7f37', red: '#cf222e', yellow: '#9a6700', blue: '#0969da', mauve: '#8250df', peach: '#bc4c00' },
    terminalColors: { background: '#ffffff', foreground: '#1f2328', accent: '#0969da' }, preview: { background: '#ffffff', foreground: '#1f2328', accent: '#0969da' },
  }),
  visualTheme({
    id: 'vs-dark', label: 'Dark', monacoTheme: 'browser-cpp-vs-dark',
    selection: { foreground: '#ffffff', background: '#264f78', inactiveBackground: '#1f3a5f' },
    cssTokens: { crust: '#181818', mantle: '#202020', base: '#1e1e1e', surface0: '#2d2d30', surface1: '#3e3e42', overlay0: '#858585', text: '#d4d4d4', subtext0: '#a0a0a0', green: '#89d185', red: '#f48771', yellow: '#dcdcaa', blue: '#569cd6', mauve: '#c586c0', peach: '#ce9178' },
    terminalColors: { background: '#181818', foreground: '#d4d4d4', accent: '#aeafad' }, preview: { background: '#1e1e1e', foreground: '#d4d4d4', accent: '#569cd6' },
  }),
  visualTheme({
    id: 'hc-light', label: 'High Contrast Light', monacoTheme: 'browser-cpp-hc-light',
    selection: { foreground: '#ffffff', background: '#0037da', inactiveBackground: '#00208a' },
    cssTokens: { crust: '#ffffff', mantle: '#ffffff', base: '#ffffff', surface0: '#e5e5e5', surface1: '#6f6f6f', overlay0: '#333333', text: '#000000', subtext0: '#333333', green: '#006400', red: '#a80000', yellow: '#704d00', blue: '#0037da', mauve: '#5b00a5', peach: '#8a3100' },
    terminalColors: { background: '#ffffff', foreground: '#000000', accent: '#0037da' }, preview: { background: '#ffffff', foreground: '#000000', accent: '#0037da' },
  }),
  visualTheme({
    id: 'hc-black', label: 'High Contrast Dark', monacoTheme: 'browser-cpp-hc-black',
    selection: { foreground: '#000000', background: '#ffff00', inactiveBackground: '#ffff00' },
    cssTokens: { crust: '#000000', mantle: '#000000', base: '#000000', surface0: '#1f1f1f', surface1: '#ffffff', overlay0: '#d0d0d0', text: '#ffffff', subtext0: '#ffffff', green: '#00ff00', red: '#ff6b6b', yellow: '#ffff00', blue: '#3daee9', mauve: '#ff8cff', peach: '#ffb86c' },
    terminalColors: { background: '#000000', foreground: '#ffffff', accent: '#ffffff' }, preview: { background: '#000000', foreground: '#ffffff', accent: '#ffff00' },
  }),
  visualTheme({
    id: 'monochrome-light', label: 'Monochrome Light', monacoTheme: 'browser-cpp-monochrome-light',
    selection: { foreground: '#000000', background: '#999999', inactiveBackground: '#bbbbbb' },
    cssTokens: { crust: '#ffffff', mantle: '#ffffff', base: '#ffffff', surface0: '#ffffff', surface1: '#666666', overlay0: '#666666', text: '#000000', subtext0: '#666666', green: '#000000', red: '#666666', yellow: '#666666', blue: '#000000', mauve: '#000000', peach: '#666666' },
    terminalColors: { background: '#dddddd', foreground: '#000000', accent: '#666666', ansi: monochromeAnsi('#000000', '#666666') }, preview: { background: '#ffffff', foreground: '#000000', accent: '#666666' },
  }),
  visualTheme({
    id: 'monochrome-dark', label: 'Monochrome Dark', monacoTheme: 'browser-cpp-monochrome-dark',
    selection: { foreground: '#ffffff', background: '#555555', inactiveBackground: '#707070' },
    cssTokens: { crust: '#000000', mantle: '#000000', base: '#000000', surface0: '#000000', surface1: '#999999', overlay0: '#999999', text: '#ffffff', subtext0: '#999999', green: '#ffffff', red: '#999999', yellow: '#999999', blue: '#ffffff', mauve: '#ffffff', peach: '#999999' },
    terminalColors: { background: '#222222', foreground: '#ffffff', accent: '#999999', ansi: monochromeAnsi('#ffffff', '#999999') }, preview: { background: '#000000', foreground: '#ffffff', accent: '#999999' },
  }),
]);

export function getVisualTheme(id) {
  return VISUAL_THEMES.find((theme) => theme.id === id) ?? VISUAL_THEMES[0];
}
