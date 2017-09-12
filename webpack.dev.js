const path = require('path');
const config = require('./gulp/config');

module.exports = {
  entry: path.resolve(__dirname, 'index.ts'),
  output: {
    filename: 'bundle.js'
  },
  devtool: 'source-map',
  module: {
    rules: [{
      test: /\.tsx?$/,
      exclude: /node_modules/,
      loader: 'ts-loader',
      options: {
        configFile: 'tsconfig.test.json',
        transpileOnly: true
      }
    }]
  },
  resolve: {
    extensions: ['.js', '.ts']
  }
};