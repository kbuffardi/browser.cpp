// webpack.config.js – builds the browser.cpp Chrome extension into dist/
const path = require('path');
const MonacoWebpackPlugin = require('monaco-editor-webpack-plugin');
const HtmlWebpackPlugin = require('html-webpack-plugin');
const CopyWebpackPlugin = require('copy-webpack-plugin');
const MiniCssExtractPlugin = require('mini-css-extract-plugin');

const dist = path.resolve(__dirname, 'dist');

// ── UI bundle (Monaco editor + xterm + app logic) ────────────────────────────
const uiConfig = {
  name: 'ui',
  entry: './src/ui/app.js',
  output: {
    path: dist,
    filename: 'bundle.js',
    clean: false,
    // Required so Monaco workers can locate themselves at runtime
    publicPath: '',
  },
  module: {
    rules: [
      {
        test: /\.css$/,
        use: [MiniCssExtractPlugin.loader, 'css-loader'],
      },
      // Monaco ships TTF fonts
      {
        test: /\.ttf$/,
        type: 'asset/resource',
      },
    ],
  },
  plugins: [
    // Emits editor.worker.js and ts.worker.js alongside bundle.js
    new MonacoWebpackPlugin({ languages: ['cpp', 'c'] }),
    new HtmlWebpackPlugin({
      template: './src/ui/index.html',
      filename: 'index.html',
      // bundle.js is injected by webpack; don't double-inject
      inject: 'body',
    }),
    new MiniCssExtractPlugin({ filename: 'styles.css' }),
    new CopyWebpackPlugin({
      patterns: [
        { from: 'manifest.json', to: 'manifest.json' },
        { from: 'icons', to: 'icons', noErrorOnMissing: true },
      ],
    }),
  ],
  resolve: {
    fallback: {
      path: false,
      fs: false,
      crypto: false,
      os: false,
    },
  },
};

// ── Background service worker ─────────────────────────────────────────────────
const bgConfig = {
  name: 'background',
  entry: './src/background/service-worker.js',
  output: { path: dist, filename: 'service-worker.js', clean: false },
  target: 'webworker',
  resolve: { fallback: { path: false, fs: false } },
};

// ── Compiler web worker ───────────────────────────────────────────────────────
const compilerConfig = {
  name: 'compiler-worker',
  entry: './src/workers/compiler.worker.js',
  output: { path: dist, filename: 'compiler.worker.js', clean: false },
  target: 'webworker',
  resolve: { fallback: { path: false, fs: false, crypto: false } },
};

module.exports = [uiConfig, bgConfig, compilerConfig];
