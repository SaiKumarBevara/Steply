const path = require('path');
const CopyPlugin = require('copy-webpack-plugin');

module.exports = {
  entry: {
    popup: './src/popup.js',
    dashboard: './src/Dashboard.jsx',
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
        { from: 'src/privacy.html', to: 'privacy.html', noErrorOnMissing: true },
        { from: 'images', to: 'images', noErrorOnMissing: true }
      ]
    })
  ],
  optimization: {
    splitChunks: {
      chunks: (chunk) => chunk.name === 'dashboard',
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
