/**
@module http-client.js
@desc Shared axios instance, configured to behave like the retired 'request' library:
- any HTTP status resolves (only network errors reject);
- no response/request body size limit;
- no keep-alive (Node 19+ enables keep-alive by default).
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
