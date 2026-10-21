import { createEgressProxy } from './proxy.js';
const server=createEgressProxy();server.listen(3128,'0.0.0.0');
process.on('SIGTERM',()=>server.close(()=>process.exit(0)));
