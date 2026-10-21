import { lookup as dnsLookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import ipaddr from 'ipaddr.js';
export type PublicTarget = {
    address: string;
    family: 4;
    hostname: string;
    port: 80 | 443;
};
export type AddressLookup = (host: string) => Promise<Array<{
    address: string;
    family: number;
}>>;
export async function resolvePublicTarget(host: string, port: number, lookup: AddressLookup = (h) => dnsLookup(h, { all: true })): Promise<PublicTarget> {
    if (port !== 80 && port !== 443)
        throw new Error('Only public HTTP/HTTPS ports are allowed');
    if (!host || host.length > 253 || !/^[a-zA-Z0-9.-]+$/.test(host) || host.startsWith('.') || host.endsWith('..'))
        throw new Error('Invalid hostname');
    const hostname = host.toLowerCase().replace(/\.$/, '');
    if (!isIP(hostname) && (!hostname.includes('.') || hostname.split('.').some(p => !p || p.length > 63 || p.startsWith('-') || p.endsWith('-'))))
        throw new Error('Invalid public hostname');
    const addresses = isIP(hostname) ? [{ address: hostname, family: isIP(hostname) }] : await lookup(hostname);
    if (!addresses.length || addresses.some(({ address, family }) => !ipaddr.isValid(address) || (family !== 4 && family !== 6) || ipaddr.parse(address).kind() !== (family === 4 ? 'ipv4' : 'ipv6') || ipaddr.parse(address).range() !== 'unicast'))
        throw new Error('Target is not public');
    const ipv4 = addresses.find(a => a.family === 4 && ipaddr.IPv4.isValidFourPartDecimal(a.address));
    if (!ipv4)
        throw new Error('Public IPv4 required');
    return { address: ipv4.address, family: 4, hostname, port };
}
