// Vercel serverless entry: same addon interface over Express, no listen().
// All routes (incl. /:config prefixes and /configure landing) via one function.
const express = require('express');
const { getRouter } = require('stremio-addon-sdk');
const landingTemplate = require('stremio-addon-sdk/src/landingTemplate');
const { createAddon } = require('../lib/create-addon');

const { interface: addonInterface } = createAddon();

const app = express();
app.use(getRouter(addonInterface));

const landingHTML = landingTemplate(addonInterface.manifest);
const serveLanding = (_, res) => {
  res.setHeader('content-type', 'text/html');
  res.end(landingHTML);
};
app.get('/', (req, res) => {
  if ((addonInterface.manifest.config || []).length) {
    res.redirect('/configure');
  } else {
    serveLanding(req, res);
  }
});
app.get('/configure', serveLanding);

module.exports = app;
