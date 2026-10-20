import { posix } from 'node:path';
import type { SandboxCommandResult, SandboxExecuteOptions } from './types';
export function taskRuntimePaths(cwd:string){
 if(!/^\/workspace\/threads\/[^/]+$/.test(cwd)||cwd.includes('..')||cwd.includes('\0'))throw new Error('Invalid task cwd');
 const root=posix.join(cwd,'.runtime');return {root,home:root+'/home',cache:root+'/cache',venv:root+'/venv'};
}
export async function prepareTaskRuntime(input:{execute:(command:string,args:string[],options:SandboxExecuteOptions)=>Promise<SandboxCommandResult>;cwd:string;imageDigest:string;dependenciesEnabled:boolean;proxyUrl?:string;abortSignal?:AbortSignal}){
 const paths=taskRuntimePaths(input.cwd);
 const bootstrap=`import pathlib,sys,platform,json,shutil,venv,os
root=pathlib.Path(sys.argv[1]); enabled=sys.argv[2]=='true'
if root.is_symlink(): raise RuntimeError('Task runtime must not be a symlink')
root.mkdir(exist_ok=True)
for name in ['home','cache']:
 p=root/name
 if p.is_symlink(): raise RuntimeError('Runtime directory must not be a symlink')
 p.mkdir(exist_ok=True)
if enabled:
 target=root/'venv'; marker=root/'environment.json'
 identity={'image':sys.argv[3],'python':sys.version,'arch':platform.machine(),'platform':sys.platform}
 try: previous=json.loads(marker.read_text())
 except (OSError,ValueError): previous=None
 if target.is_symlink() or marker.is_symlink(): raise RuntimeError('Invalid task environment')
 if previous!=identity or not (target/'bin/python').exists():
  if target.exists(): shutil.rmtree(target)
  if marker.exists(): marker.unlink()
  venv.EnvBuilder(with_pip=True).create(target)
  temp=root/'environment.json.tmp';temp.write_text(json.dumps(identity));os.replace(temp,marker)
`;
 const result=await input.execute('python3',['-c',bootstrap,paths.root,String(input.dependenciesEnabled),input.imageDigest],{cwd:input.cwd,timeoutMs:120000,abortSignal:input.abortSignal,env:['PATH=/usr/local/bin:/usr/bin:/bin']});
 if(result.exitCode!==0)throw new Error('Task environment initialization failed: '+result.stderr);
 const env=[`HOME=${paths.home}`,`XDG_CACHE_HOME=${paths.cache}`,`PIP_CACHE_DIR=${paths.cache}/pip`,`npm_config_cache=${paths.cache}/npm`,`npm_config_prefix=${paths.root}/node`,`PYTHONNOUSERSITE=1`,`PATH=${input.dependenciesEnabled?paths.venv+'/bin:':''}${paths.root}/node/bin:/usr/local/bin:/usr/bin:/bin`];
 if(input.dependenciesEnabled)env.push(`VIRTUAL_ENV=${paths.venv}`,'PIP_REQUIRE_VIRTUALENV=true');
 for(const key of ['HTTP_PROXY','HTTPS_PROXY','ALL_PROXY','http_proxy','https_proxy','all_proxy'])env.push(`${key}=${input.proxyUrl??''}`);
 env.push('NO_PROXY=','no_proxy=');
 return {env,python:input.dependenciesEnabled?paths.venv+'/bin/python':'python3'};
}
