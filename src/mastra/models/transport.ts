import { lookup } from 'node:dns';
import { isIP } from 'node:net';
import ipaddr from 'ipaddr.js';
import { Agent } from 'undici';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import { createOpenAI } from '@ai-sdk/openai';
import type { OpenAICompatibleConfig } from '@mastra/core/llm';
import { ModelCatalogError } from './types';

/** Recheck every DNS answer during connection establishment, including after DNS changes. */
export function assertPublicAddress(address: string): void {
  try {
    if (ipaddr.process(address).range() === 'unicast') return;
  } catch {
    // An unknown address is never safe for an outbound model connection.
  }
  throw new ModelCatalogError('invalid_input', 'Model endpoint resolved to a non-public address');
}

const modelDispatcher = new Agent({
  connect: {
    lookup(hostname, options, callback) {
      lookup(hostname, { ...options, all: true }, (error, addresses) => {
        if (error) return callback(error, '');
        try {
          if (!addresses.length) throw new Error('Model endpoint has no DNS addresses');
          for (const result of addresses) assertPublicAddress(result.address);
          if (options.all) callback(null, addresses);
          else callback(null, addresses[0].address, addresses[0].family);
        } catch (cause) {
          callback(cause instanceof Error ? cause : new Error(String(cause)), '');
        }
      });
    },
  },
});

const outboundFetch: typeof fetch = (input, init) =>
  globalThis.fetch(input, { ...init, dispatcher: modelDispatcher } as RequestInit);

export function createGuardedModelFetch(baseUrl: URL, fetchImpl: typeof fetch = outboundFetch): typeof fetch {
  const basePath = baseUrl.pathname.replace(/\/+$/, '');
  return async (input, init) => {
    const target = new URL(input instanceof Request ? input.url : String(input));
    if (target.origin !== baseUrl.origin || !target.pathname.startsWith(`${basePath}/`)) {
      throw new ModelCatalogError('invalid_input', 'Model request escaped its approved base URL');
    }
    const host = target.hostname.replace(/^\[|\]$/g, '');
    if (isIP(host)) assertPublicAddress(host);
    const response = await fetchImpl(input, { ...init, redirect: 'error' });
    if (response.status >= 300 && response.status < 400) {
      await response.body?.cancel();
      throw new ModelCatalogError('invalid_input', 'Model endpoint redirect is not allowed');
    }
    return response;
  };
}

export function createTransportModel(config: OpenAICompatibleConfig) {
  const [providerId, ...modelParts] = 'id' in config
    ? config.id.split('/')
    : [config.providerId, config.modelId];
  const modelId = modelParts.join('/');
  if (!config.url || !config.apiKey) throw new ModelCatalogError('invalid_input', 'Model connection is incomplete');
  const fetch = createGuardedModelFetch(new URL(config.url));
  if (config.api === 'responses') {
    return createOpenAI({ name: providerId, baseURL: config.url, apiKey: config.apiKey, fetch }).responses(modelId);
  }
  return createOpenAICompatible({
    name: providerId,
    baseURL: config.url,
    apiKey: config.apiKey,
    fetch,
    supportsStructuredOutputs: true,
  }).chatModel(modelId);
}
