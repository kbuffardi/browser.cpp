'use strict';

export const DEFAULT_VISUAL_THEME_ID = 'browser-cpp-dark';

const terminal = (background, foreground, accent) => ({
  background, foreground, cursor: accent, cursorAccent: background,
  black: foreground, red: '#c01c28', green: '#2d7d46', yellow: '#9a6700',
  blue: '#0969da', magenta: '#8250df', cyan: '#0a7b83', white: foreground,
  brightBlack: '#768390', brightRed: '#d1242f', brightGreen: '#1a7f37',
  brightYellow: '#bf8700', brightBlue: '#218bff', brightMagenta: '#a475f9',
  brightCyan: '#1b9aaa', brightWhite: foreground,
});

export const VISUAL_THEMES = Object.freeze([
  {
    id: 'browser-cpp-dark', label: 'browser.cpp Dark', monacoTheme: 'browser-cpp-dark',
    cssTokens: { crust: '#11111b', mantle: '#181825', base: '#1e1e2e', surface0: '#313244', surface1: '#45475a', overlay0: '#6c7086', text: '#cdd6f4', subtext0: '#a6adc8', green: '#a6e3a1', red: '#f38ba8', yellow: '#f9e2af', blue: '#89b4fa', mauve: '#cba6f7', peach: '#fab387' },
    terminalTheme: terminal('#11111b', '#cdd6f4', '#f5c2e7'), preview: { background: '#1e1e2e', foreground: '#cdd6f4', accent: '#89b4fa' },
  },
  {
    id: 'vs', label: 'Light', monacoTheme: 'vs',
    cssTokens: { crust: '#f6f8fa', mantle: '#ffffff', base: '#ffffff', surface0: '#d0d7de', surface1: '#afb8c1', overlay0: '#57606a', text: '#1f2328', subtext0: '#57606a', green: '#1a7f37', red: '#cf222e', yellow: '#9a6700', blue: '#0969da', mauve: '#8250df', peach: '#bc4c00' },
    terminalTheme: terminal('#ffffff', '#1f2328', '#0969da'), preview: { background: '#ffffff', foreground: '#1f2328', accent: '#0969da' },
  },
  {
    id: 'vs-dark', label: 'Dark', monacoTheme: 'vs-dark',
    cssTokens: { crust: '#181818', mantle: '#202020', base: '#1e1e1e', surface0: '#2d2d30', surface1: '#3e3e42', overlay0: '#858585', text: '#d4d4d4', subtext0: '#a0a0a0', green: '#89d185', red: '#f48771', yellow: '#dcdcaa', blue: '#569cd6', mauve: '#c586c0', peach: '#ce9178' },
    terminalTheme: terminal('#181818', '#d4d4d4', '#aeafad'), preview: { background: '#1e1e1e', foreground: '#d4d4d4', accent: '#569cd6' },
  },
  {
    id: 'hc-light', label: 'High Contrast Light', monacoTheme: 'hc-light',
    cssTokens: { crust: '#ffffff', mantle: '#ffffff', base: '#ffffff', surface0: '#e5e5e5', surface1: '#6f6f6f', overlay0: '#333333', text: '#000000', subtext0: '#333333', green: '#006400', red: '#a80000', yellow: '#704d00', blue: '#0037da', mauve: '#5b00a5', peach: '#8a3100' },
    terminalTheme: terminal('#ffffff', '#000000', '#0037da'), preview: { background: '#ffffff', foreground: '#000000', accent: '#0037da' },
  },
  {
    id: 'hc-black', label: 'High Contrast Dark', monacoTheme: 'hc-black',
    cssTokens: { crust: '#000000', mantle: '#000000', base: '#000000', surface0: '#1f1f1f', surface1: '#ffffff', overlay0: '#d0d0d0', text: '#ffffff', subtext0: '#ffffff', green: '#00ff00', red: '#ff6b6b', yellow: '#ffff00', blue: '#3daee9', mauve: '#ff8cff', peach: '#ffb86c' },
    terminalTheme: terminal('#000000', '#ffffff', '#ffffff'), preview: { background: '#000000', foreground: '#ffffff', accent: '#ffff00' },
  },
]);

export function getVisualTheme(id) {
  return VISUAL_THEMES.find((theme) => theme.id === id) ?? VISUAL_THEMES[0];
}
