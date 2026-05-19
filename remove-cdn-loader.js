module.exports = function(source) {
  // Remove the CDN URL that triggers Chrome Web Store's remotely hosted code violation
  return source.replace(
    /["']https:\/\/cdnjs\.cloudflare\.com\/ajax\/libs\/pdfobject\/2\.1\.1\/pdfobject\.min\.js["']/g,
    '""'
  );
};
