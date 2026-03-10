'use strict';

const express = require('express');
const config = require('./config');
const db = require('./db');
const pyrusRoutes = require('./routes/pyrus');
const sendpulseRoutes = require('./routes/sendpulse');

const app = express();

// Save raw body for HMAC verification before JSON parsing
app.use((req, res, next) => {
  let data = '';
  req.on('data', (chunk) => { data += chunk; });
  req.on('end', () => {
    req.rawBody = data;
    try {
      req.body = data ? JSON.parse(data) : {};
    } catch {
      req.body = {};
    }
    next();
  });
});

app.use('/pyrus', (req, res, next) => {
  console.log(`[pyrus] ${req.method} ${req.path}`, req.rawBody ? req.rawBody.slice(0, 300) : '');
  next();
});
app.use('/pyrus', pyrusRoutes);
app.use('/sendpulse', sendpulseRoutes);

app.get('/health', (req, res) => res.json({ status: 'ok' }));

async function start() {
  await db.initSchema();
  app.listen(config.port, () => {
    console.log(`Server running on port ${config.port}`);
  });
}

start().catch((err) => {
  console.error('Failed to start:', err.message);
  process.exit(1);
});
