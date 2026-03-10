'use strict';

module.exports = {
  port: process.env.PORT || 3000,
  databaseUrl: process.env.DATABASE_URL,
  pyrus: {
    clientId: process.env.PYRUS_CLIENT_ID,
    secretKey: process.env.PYRUS_SECRET_KEY,
    webhookSecret: process.env.PYRUS_WEBHOOK_SECRET,
    baseUrl: 'https://extensions.pyrus.com/v1',
  },
};
