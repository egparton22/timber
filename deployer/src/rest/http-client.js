/**
@module http-client.js
@desc axios instance configured to behave like the retired `request` library:
any HTTP status resolves (only network errors reject), no body size limits, no keep-alive.
*/

import http from 'http';
import https from 'https';
import axios from 'axios';

export default axios.create({
  validateStatus: () => true,
  maxBodyLength: Infinity,
  maxContentLength: Infinity,
  httpAgent: new http.Agent({ keepAlive: false }),
  httpsAgent: new https.Agent({ keepAlive: false }),
});
