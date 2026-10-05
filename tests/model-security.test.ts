import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import test from 'node:test';
import {
  decryptApiKey,
  encryptApiKey,
  keyHint,
} from '../src/mastra/models/crypto';
import {
  assertAllowedEndpoint,
  normalizeModelEndpoint,
} from '../src/mastra/models/endpoint-policy';

const TEST_KEY = randomBytes(32).toString('base64');
const OTHER_KEY = randomBytes(32).toString('base64');
const ALLOWED_ORIGINS = 'https://api.openai.com,https://api.anthropic.com';

function withEnv<T>(vars: Record<string, string | undefined>, fn: () => T): T {
  const previous = new Map<string, string | undefined>();
  for (const [name, value] of Object.entries(vars)) {
    previous.set(name, process.env[name]);
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  try {
    return fn();
  } finally {
    for (const [name, value] of previous) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
}

async function withEnvAsync<T>(
  vars: Record<string, string | undefined>,
  fn: () => Promise<T>,
): Promise<T> {
  const previous = new Map<string, string | undefined>();
  for (const [name, value] of Object.entries(vars)) {
    previous.set(name, process.env[name]);
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  try {
    return await fn();
  } finally {
    for (const [name, value] of previous) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
}

test('model key encryption is authenticated', () => {
  withEnv({ MODEL_CONFIG_ENCRYPTION_KEY: TEST_KEY }, () => {
    const plain = 'sk-test-1234';
    const encrypted = encryptApiKey(plain);
    assert.equal(decryptApiKey(encrypted), plain);
    assert.notEqual(encryptApiKey(plain), encrypted);

    const [version, encoded] = encrypted.split(':');
    const tamperedPayload = Buffer.from(encoded, 'base64url');
    tamperedPayload[12] ^= 1;
    const tampered = `${version}:${tamperedPayload.toString('base64url')}`;
    assert.throws(() => decryptApiKey(tampered));

    withEnv({ MODEL_CONFIG_ENCRYPTION_KEY: OTHER_KEY }, () => {
      assert.throws(() => decryptApiKey(encrypted));
    });

    assert.equal(keyHint('sk-test-1234'), '1234');
    assert.equal(keyHint('ab'), 'ab');
    assert.equal(keyHint(''), '');
  });
});

test('model key encryption fails closed without valid key', () => {
  assert.throws(() => encryptApiKey('sk-test'), /MODEL_CONFIG_ENCRYPTION_KEY/);
  withEnv({ MODEL_CONFIG_ENCRYPTION_KEY: 'too-short' }, () => {
    assert.throws(() => encryptApiKey('sk-test'), /MODEL_CONFIG_ENCRYPTION_KEY/);
  });
});

test('endpoint policy rejects unsafe URLs', async () => {
  await withEnvAsync({ MODEL_ENDPOINT_ALLOWLIST: ALLOWED_ORIGINS }, async () => {
    const rejectNormalize = (raw: string) =>
      assert.throws(() => normalizeModelEndpoint(raw));
    const rejectPolicy = async (raw: string) => {
      await assert.rejects(async () => {
        const url = normalizeModelEndpoint(raw);
        await assertAllowedEndpoint(url);
      });
    };

    rejectNormalize('http://api.openai.com/v1');
    rejectNormalize('https://user:pass@api.openai.com/v1');
    rejectNormalize('https://api.openai.com/v1#fragment');

    await rejectPolicy('https://127.0.0.1/v1');
    await rejectPolicy('https://localhost/v1');
    await rejectPolicy('https://10.0.0.1/v1');
    await rejectPolicy('https://192.168.1.1/v1');
    await rejectPolicy('https://169.254.169.254/latest/meta-data');
    await rejectPolicy('https://metadata.google.internal/');
    await rejectPolicy('https://[::1]/');
    await rejectPolicy('https://[fe80::1]/');
    await rejectPolicy('https://evil.example.com/v1');
  });
});

test('endpoint policy rejects invalid allowlist entries', async () => {
  await withEnvAsync(
    { MODEL_ENDPOINT_ALLOWLIST: 'http://api.openai.com,https://api.anthropic.com' },
    async () => {
      const url = normalizeModelEndpoint('https://api.anthropic.com/v1');
      await assert.rejects(() => assertAllowedEndpoint(url), /must use HTTPS/);
    },
  );
  await withEnvAsync(
    { MODEL_ENDPOINT_ALLOWLIST: 'not-a-url,https://api.anthropic.com' },
    async () => {
      const url = normalizeModelEndpoint('https://api.anthropic.com/v1');
      await assert.rejects(() => assertAllowedEndpoint(url), /not a valid HTTPS origin/);
    },
  );
});

test('endpoint policy accepts allowlisted HTTPS origins', async () => {
  await withEnvAsync({ MODEL_ENDPOINT_ALLOWLIST: ALLOWED_ORIGINS }, async () => {
    const url = normalizeModelEndpoint('https://api.openai.com/v1/');
    assert.equal(url.origin, 'https://api.openai.com');
    await assertAllowedEndpoint(url);
  });
});

test('endpoint policy allows only the approved HTTP model Base URL', async () => {
  const approved = 'http://101.37.135.116:7864/v1';
  await withEnvAsync({ MODEL_ENDPOINT_ALLOWLIST: `${ALLOWED_ORIGINS},${approved}` }, async () => {
    const url = normalizeModelEndpoint(approved);
    assert.equal(url.toString(), approved);
    await assertAllowedEndpoint(url);

    for (const other of [
      'http://101.37.135.116:7864/v2',
      'http://101.37.135.116:7865/v1',
      'http://101.37.135.116:7864/v1?debug=1',
      'http://api.openai.com/v1',
    ]) {
      await assert.rejects(async () => {
        await assertAllowedEndpoint(normalizeModelEndpoint(other));
      });
    }

    await assertAllowedEndpoint(normalizeModelEndpoint('https://api.openai.com/v1'));
  });
});

test('the approved HTTP Base URL still requires an explicit allowlist entry', async () => {
  await withEnvAsync({ MODEL_ENDPOINT_ALLOWLIST: ALLOWED_ORIGINS }, async () => {
    await assert.rejects(
      () => assertAllowedEndpoint(normalizeModelEndpoint('http://101.37.135.116:7864/v1')),
      /allowlist/,
    );
  });
});

test('endpoint policy rejects when allowlist is missing', async () => {
  await withEnvAsync({ MODEL_ENDPOINT_ALLOWLIST: undefined }, async () => {
    const url = normalizeModelEndpoint('https://api.openai.com/v1');
    await assert.rejects(() => assertAllowedEndpoint(url), /MODEL_ENDPOINT_ALLOWLIST/);
  });
});
