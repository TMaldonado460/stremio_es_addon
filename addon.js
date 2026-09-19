// Local server entry: `npm start`. Production serverless uses api/index.js.
const { serveHTTP } = require('stremio-addon-sdk');
const { createAddon } = require('./lib/create-addon');

const { interface: addonInterface, env } = createAddon();

serveHTTP(addonInterface, { port: env.port }).then(({ url }) => {
  console.log(`[${env.addonName}] escuchando. Manifest: ${url}`);
  console.log('Configurar tokens (temporal 24h o reales): abre /configure en la misma base, pega los tokens e INSTALL.');
});
