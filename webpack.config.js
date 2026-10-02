const path = require('path');
const CopyPlugin = require('copy-webpack-plugin');

module.exports = {
  entry: {
    popup: './src/popup.js',
    dashboard: './src/Dashboard.jsx',
    capture: './src/capture.js',
    content: './src/content.js',
    background: './src/background.js'
  },
  output: {
    path: path.resolve(__dirname, 'dist'),
    filename: '[name].js',
    clean: true
  },
  module: {
    rules: [
      {
        test: /\.(js|jsx)$/,
        exclude: /node_modules/,
        use: {
          loader: 'babel-loader',
          options: {
            presets: ['@babel/preset-env', ['@babel/preset-react', { runtime: 'automatic' }]]
          }
        }
      },
      {
        test: /\.js$/,
        include: /node_modules[\\/]jspdf/,
        use: [path.resolve(__dirname, 'remove-cdn-loader.js')]
      },
      {
        test: /\.css$/,
        use: ['style-loader', 'css-loader']
      }
    ]
  },
  resolve: {
    extensions: ['.js', '.jsx']
  },
  plugins: [
    new CopyPlugin({
      patterns: [
        { from: 'manifest.json', to: 'manifest.json' },
        { from: 'src/popup.html', to: 'popup.html', noErrorOnMissing: true },
        { from: 'src/dashboard.html', to: 'dashboard.html', noErrorOnMissing: true },
        { from: 'src/capture.html', to: 'capture.html', noErrorOnMissing: true },
        { from: 'src/privacy.html', to: 'privacy.html', noErrorOnMissing: true },
        { from: 'images', to: 'images', noErrorOnMissing: true },
        // Tabler icon webfont, vendored locally. Previously loaded from
        // cdn.jsdelivr.net, which counts as remotely hosted code under the
        // Chrome Web Store MV3 policy. The version is pinned exactly in
        // package.json so the file layout and the @font-face patch below
        // cannot shift underneath us.
        {
          from: 'node_modules/@tabler/icons-webfont/tabler-icons.min.css',
          to: 'vendor/tabler/tabler-icons.min.css',
          transform(content) {
            // Only woff2 is copied, so repoint the single @font-face at it —
            // otherwise Chrome requests the absent eot/ttf/woff files and
            // logs 404s on every page load.
            const css = content.toString();
            const patched = css.replace(
              /src:url\("\.\/fonts\/tabler-icons\.eot[^}]*/,
              'src:url("./fonts/tabler-icons.woff2?v2.44.0") format("woff2")'
            );
            if (patched === css) {
              throw new Error(
                'Tabler @font-face src block not found — check the @tabler/icons-webfont version pin'
              );
            }
            return patched;
          }
        },
        {
          from: 'node_modules/@tabler/icons-webfont/fonts/tabler-icons.woff2',
          to: 'vendor/tabler/fonts/tabler-icons.woff2'
        }
      ]
    })
  ],
  optimization: {
    splitChunks: {
      // The capture page is in here so it shares the dashboard's jsPDF chunk instead of
      // bundling a second 600 KB copy of it. popup/content/background stay out: they
      // must each be a single self-contained file.
      chunks: (chunk) => chunk.name === 'dashboard' || chunk.name === 'capture',
      cacheGroups: {
        react: {
          test: /[\\/]node_modules[\\/](react|react-dom|scheduler)[\\/]/,
          name: 'react-vendor',
          priority: 20,
        },
        exportLibs: {
          test: /[\\/]node_modules[\\/](jspdf|docx|html2canvas)[\\/]/,
          name: 'export-libs',
          priority: 15,
        },
        vendor: {
          test: /[\\/]node_modules[\\/]/,
          name: 'vendors',
          priority: 10,
        },
      }
    }
  },
  mode: process.env.NODE_ENV === 'production' ? 'production' : 'development',
  devtool: 'cheap-module-source-map'
};
