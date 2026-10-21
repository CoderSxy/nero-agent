import { build } from 'esbuild';
await build({entryPoints:['src/mastra/sandbox/network/main.ts'],bundle:true,platform:'node',format:'esm',outfile:'sandbox/egress/dist/proxy.mjs'});
