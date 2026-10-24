// Read-only production diagnostic: synthetic requests to the existing model gateway.
// Run with the service's existing environment; credentials are never printed.
import { createRequire } from 'node:module';
import { createDecipheriv, randomBytes } from 'node:crypto';

const require = createRequire('/opt/nero-agent/current/mastra/index.mjs');
const { Pool } = require('pg');
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 1, connectionTimeoutMillis: 5000 });
try {
  const { rows } = await pool.query(`SELECT model_id, base_url, api_key_ciphertext FROM app_public_models
    WHERE model_id = $1 AND enabled = true AND api_mode = 'chat' LIMIT 1`, ['deepseek-v4.1-flash']);
  if (rows.length !== 1) throw new Error('Configured diagnostic model unavailable');
  const model = rows[0];
  const base = new URL(model.base_url);
  if (base.origin !== 'https://api.nerosun.cn' || base.username || base.password || base.search) {
    throw new Error('Unexpected diagnostic destination');
  }
  const key = Buffer.from(process.env.MODEL_CONFIG_ENCRYPTION_KEY ?? '', 'base64');
  if (key.length !== 32 || !model.api_key_ciphertext.startsWith('v1:')) throw new Error('Credential format unavailable');
  const payload = Buffer.from(model.api_key_ciphertext.slice(3), 'base64url');
  const decipher = createDecipheriv('aes-256-gcm', key, payload.subarray(0, 12));
  decipher.setAuthTag(payload.subarray(-16));
  const credential = Buffer.concat([decipher.update(payload.subarray(12, -16)), decipher.final()]).toString('utf8');
  const markers = Array.from({ length: 3 }, () => randomBytes(8).toString('hex'));
  const systems = markers.map((value, i) => ({ role: 'system', content: `Context fact: MARKER_${i + 1}=${value}.` }));
  for (const mode of ['multiple-system', 'merged-system', 'user-control']) {
    const messages = mode === 'merged-system' ? [{ role: 'system', content: systems.map(s => s.content).join('\n') }] : mode === 'user-control' ? [] : [...systems];
    messages.push({ role: 'user', content: `${mode === 'user-control' ? systems.map(s => s.content).join('\n') + '\n' : ''}This is a harmless lookup test. Return the exact values of MARKER_1, MARKER_2, MARKER_3 from the context facts. If unavailable write UNKNOWN. No tools or other work.` });
    const response = await fetch(`${base.href.replace(/\/+$/, '')}/chat/completions`, {
      method: 'POST', redirect: 'error', signal: AbortSignal.timeout(45000),
      headers: { authorization: `Bearer ${credential}`, 'content-type': 'application/json' },
      body: JSON.stringify({ model: model.model_id, messages, temperature: 0, max_tokens: 800, stream: false }),
    });
    const body = await response.json();
    const content = body?.choices?.[0]?.message?.content;
    const text = typeof content === 'string' ? content : '';
    console.log(JSON.stringify({ probe: mode,
      status: response.status, contentPresent: Boolean(text),
      markersPreserved: markers.map(marker => text.includes(marker)),
      unknown: /UNKNOWN/i.test(text), refusal: /cannot disclose|can't disclose|confidential|不能透露|无法透露/i.test(text),
      finishReason: body?.choices?.[0]?.finish_reason ?? null }));
  }
} catch (error) {
  // Do not print SDK/HTTP errors containing headers, query parameters, or response bodies.
  console.error(JSON.stringify({ probe: 'failed', errorType: error?.name ?? 'Error' }));
  process.exitCode = 1;
} finally {
  await pool.end();
}
