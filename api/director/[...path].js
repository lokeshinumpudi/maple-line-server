import { createDirectorHandler } from '../../src/server.js';

export default createDirectorHandler({
  hosted: true,
  allowedOrigins: (
    process.env.ALLOWED_ORIGINS ?? 'https://lokeshinumpudi.com,https://www.lokeshinumpudi.com'
  )
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean),
  cacheDirectory: '/tmp/maple-line-narration',
});
