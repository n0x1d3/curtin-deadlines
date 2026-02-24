'use strict';

const CopyWebpackPlugin = require('copy-webpack-plugin');
const MiniCssExtractPlugin = require('mini-css-extract-plugin');
const path = require('path');

const PATHS = require('./paths');

// File types treated as static assets (excluded from stats output)
const IMAGE_TYPES = /\.(png|jpe?g|gif|svg)$/i;

const common = {
  output: {
    // All compiled bundles and assets land in /build
    path: PATHS.build,
    filename: '[name].js',
  },
  stats: {
    all: false,
    errors: true,
    builtAt: true,
    assets: true,
    excludeAssets: [IMAGE_TYPES],
  },
  module: {
    rules: [
      // Compile TypeScript via ts-loader
      {
        test: /\.ts$/,
        use: ['ts-loader'],
      },
      // Extract CSS into separate files so sidePanel.html can link them
      {
        test: /\.css$/,
        use: [MiniCssExtractPlugin.loader, 'css-loader'],
      },
      // Handle image assets (icons etc.)
      {
        test: IMAGE_TYPES,
        use: [
          {
            loader: 'file-loader',
            options: {
              outputPath: 'images',
              name: '[name].[ext]',
            },
          },
        ],
      },
      // Handle font files referenced from @font-face in CSS
      {
        test: /\.(ttf|woff|woff2)$/,
        type: 'asset/resource',
        generator: {
          filename: 'fonts/[name][ext]',
        },
      },
    ],
  },
  resolve: {
    // Resolve .ts before .js so TypeScript source takes precedence
    extensions: ['.ts', '.js'],
  },
  plugins: [
    // Copy everything in public/ to build/ (manifest, HTML, icons)
    new CopyWebpackPlugin({
      patterns: [
        {
          from: '**/*',
          context: 'public',
        },
        // Copy the PDF.js worker so the side panel can reference it via
        // chrome.runtime.getURL('pdf.worker.min.js')
        {
          from: path.resolve(__dirname, '../node_modules/pdfjs-dist/build/pdf.worker.min.js'),
          to: 'pdf.worker.min.js',
        },
      ],
    }),
    // Extract CSS into [name].css (e.g. sidePanel.css)
    new MiniCssExtractPlugin({
      filename: '[name].css',
    }),
  ],
};

module.exports = common;
