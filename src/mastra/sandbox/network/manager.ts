import { workloadPolicy } from '../workload-policy';
import { networkAttachmentsMatch } from '../docker/network-state';
import type { DockerEngine } from '../docker/client';
import { createDockerodeEngine } from '../docker/client';
import type { SandboxOwner } from '../types';
import { commandQueue } from '../execution-queue';
import { getSandboxRuntimeConfig, runtimeFingerprint } from '../runtime-config';
import { createDockerNetworkEngine, type DockerNetworkEngine } from './docker-engine';
export type SandboxNetworkContext = {
    networkId: string;
    proxyUrl: string;
    fingerprint: string;
};
const LABEL = 'nero.egress';
export class SandboxNetworkManager {
    private tails = new Map<string, Promise<unknown>>();
    private lastUsed = new Map<string, number>();
    constructor(private engine: DockerEngine, private networks: DockerNetworkEngine) { }
    async ensure(owner: SandboxOwner): Promise<SandboxNetworkContext> {return this.exclusive(owner,()=>this.provision(owner));}
    private async exclusive<T>(owner:SandboxOwner,task:()=>Promise<T>):Promise<T>{
        const previous = this.tails.get(owner.userId) ?? Promise.resolve();
        const next = previous.catch(() => { }).then(task);
        this.tails.set(owner.userId, next);
        try {
            return await next;
        }
        finally {
            if (this.tails.get(owner.userId) === next)
                this.tails.delete(owner.userId);
        }
    }
    private async provision(owner: SandboxOwner): Promise<SandboxNetworkContext> {
        if (!/^[a-f0-9-]{36}$/.test(owner.userId))
            throw new Error('Invalid sandbox network owner');
        const config = getSandboxRuntimeConfig();
        if (config.networkMode !== 'public-http' || !config.proxyImage)
            throw new Error('Public network unavailable');
        const labels = { [LABEL]: '1', 'nero.egress.user': owner.userId, 'nero.egress.created':String(Date.now()) };
        const prefix = 'nero-egress-' + owner.userId;
        const getNetwork = async (name: string, internal: boolean) => {
            const n = await this.networks.inspect(name) ?? await this.networks.create(name, internal, labels);
            if (n.Labels?.[LABEL] !== '1' || n.Labels?.['nero.egress.user'] !== owner.userId || n.Internal !== internal || n.EnableIPv6 || (internal && n.Options?.['com.docker.network.bridge.inhibit_ipv4'] !== 'true'))
                throw new Error('Sandbox network policy mismatch');
            return n;
        };
        const inside = await getNetwork(prefix + '-internal', true);
        const outside = await getNetwork(prefix + '-outbound', false);
        const fingerprint = runtimeFingerprint(config.proxyImage);
        const proxies = (await this.engine.findLabeled('nero.egress.user', owner.userId)).filter(p => p.Config?.Labels?.[LABEL] === '1');
        let proxy: typeof proxies[number] | undefined = proxies[0];
        if (proxies.length > 1)
            throw new Error('Ambiguous sandbox egress containers');
        const expectedImage=await this.engine.resolveImageId?.(config.proxyImage);
        if (proxy && (!workloadPolicy.compatible(proxy) || !networkAttachmentsMatch(proxy,[inside.Id,outside.Id]) || (expectedImage&&proxy.Image!==expectedImage) || proxy.Config?.User!=='10001:10001' || proxy.HostConfig?.ReadonlyRootfs!==true || !proxy.HostConfig?.CapDrop?.includes('ALL') || proxy.Config?.Labels?.['nero.egress.fingerprint'] !== fingerprint || proxy.HostConfig?.NetworkMode !== outside.Id || proxy.HostConfig?.Sysctls?.['net.ipv4.ip_forward'] !== '0' || proxy.HostConfig?.Privileged || Object.keys(proxy.HostConfig?.PortBindings ?? {}).length)) {
            await this.engine.remove(proxy.Id, true);
            proxy = undefined;
        }
        if (!proxy) {
            const result = await this.engine.create({ Image: config.proxyImage, User: '10001:10001', Env: [], Labels: { ...labels, 'nero.egress.fingerprint': fingerprint }, HostConfig: { NetworkMode: outside.Id, ReadonlyRootfs: true, Privileged: false, CapDrop: ['ALL'], SecurityOpt: ['no-new-privileges:true'], Sysctls: { 'net.ipv4.ip_forward': '0' }, Memory: 128 * 1024 * 1024, MemorySwap: 128 * 1024 * 1024, PidsLimit: 64, NanoCpus: 250000000 } });
            try {
                await this.networks.connect(inside.Id, result.id, 'nero-egress');
                await this.engine.start(result.id);
            }
            catch (e) {
                await this.engine.remove(result.id, true).catch(() => { });
                throw e;
            }
            proxy = (await this.engine.inspect(result.id))!;
        }
        else if (!proxy.State.Running) {
            await this.engine.start(proxy.Id);
        }
        let healthy = false;
        let healthError = '';
        for (let attempt = 0; attempt < 5; attempt++) {
            try {
                const health = await this.engine.exec(proxy.Id, 'node', ['-e', "const s=require('net').connect(3128,'127.0.0.1',()=>{s.end();process.exit(0)});s.on('error',()=>process.exit(1));setTimeout(()=>process.exit(1),2000)"], { cwd: '/', timeoutMs: 12000 });
                if (health.exitCode === 0) {
                    healthy = true;
                    break;
                }
                healthError = health.stderr;
            }
            catch (error) {
                healthError = String(error);
            }
            await new Promise(r => setTimeout(r, 100));
        }
        if (!healthy)
            throw new Error('Sandbox egress proxy is unavailable: ' + healthError);
        this.lastUsed.set(owner.userId, Date.now());
        return { networkId: inside.Id, proxyUrl: 'http://nero-egress:3128', fingerprint };
    }
    async removeIdle(owner:SandboxOwner):Promise<void>{return this.exclusive(owner,()=>this.collectIdle(owner));}
    private async collectIdle(owner:SandboxOwner):Promise<void>{
        if (commandQueue.isUserBusy(owner.userId))
            return;
        if ((await this.engine.findLabeled('nero.sandbox.user', owner.userId)).some(c => c.State.Running))
            return;
        if ((await this.engine.findLabeled('nero.skill-run.user', owner.userId)).length)
            return;
        for (const p of await this.engine.findLabeled('nero.egress.user', owner.userId))
            if (p.Config?.Labels?.[LABEL] === '1')
                await this.engine.remove(p.Id, true);
        for (const suffix of ['-internal', '-outbound']) {
            const n = await this.networks.inspect('nero-egress-' + owner.userId + suffix);
            if (n?.Labels?.[LABEL] === '1' && n.Labels?.['nero.egress.user'] === owner.userId)
                await this.networks.remove(n.Id);
        }
        this.lastUsed.delete(owner.userId);
    }
    async sweep(now=Date.now()):Promise<void>{
      const candidates=new Map<string,number>();
      for(const p of await this.engine.findLabeled(LABEL,'1')){
        const userId=p.Config?.Labels?.['nero.egress.user'];if(!userId)continue;
        candidates.set(userId,this.lastUsed.get(userId)??Date.parse(String(p.Created??'')));
      }
      for(const n of await this.networks.listOwned?.()??[]){
        const userId=n.Labels?.['nero.egress.user'];if(!userId||candidates.has(userId))continue;
        const created=Number(n.Labels?.['nero.egress.created'])||Date.parse(n.Created??'');
        candidates.set(userId,this.lastUsed.get(userId)??created);
      }
      for(const [userId,last] of candidates)if(Number.isFinite(last)&&now-last>=86400000)
        await this.removeIdle({userId,sandboxId:'sb_'+userId});
    }

}
let shared: Promise<SandboxNetworkManager> | undefined;
export function sandboxNetworkManager(): Promise<SandboxNetworkManager> {
    if (!shared) {
        shared = Promise.all([createDockerodeEngine(), createDockerNetworkEngine()]).then(([engine, networks]) => { const manager = new SandboxNetworkManager(engine, networks); const timer = setInterval(() => void manager.sweep().catch(e => console.error('Sandbox egress cleanup failed', e)), 60000); timer.unref(); return manager; }).catch(e => { shared = undefined; throw e; });
    }
    return shared;
}
