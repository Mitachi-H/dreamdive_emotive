const path = require('path');
const fs = require('fs');
const dotenv = require('dotenv');

// Load .env if present (server/.env)
const envPath = path.join(__dirname, '..', '.env');
if (fs.existsSync(envPath)) {
  dotenv.config({ path: envPath });
}

const config = {
  env: process.env.NODE_ENV || 'development',
  port: parseInt(process.env.PORT || '3000', 10),
  host: process.env.HOST || '0.0.0.0',
  apiToken: process.env.API_AUTH_TOKEN || '',
  autoConnect: String(process.env.AUTO_CONNECT || 'false').toLowerCase() === 'true',
  cortex: {
    url: process.env.CORTEX_URL || 'wss://localhost:6868',
    clientId: process.env.CORTEX_CLIENT_ID,
    clientSecret: process.env.CORTEX_CLIENT_SECRET,
    license: process.env.CORTEX_LICENSE,
    debit: process.env.CORTEX_DEBIT ? Number(process.env.CORTEX_DEBIT) : undefined,
    profile: process.env.CORTEX_PROFILE,
  },
};

module.exports = config;
