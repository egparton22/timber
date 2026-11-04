/**
@module http-client.js
@desc axios instance configured to behave like the `request` library it replaced:
resolve on any HTTP status (only network errors reject) and don't keep connections alive.
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
