// Digest-pinned compiler, fixed paths, fixed Rust release and explicit WASI target.
import {spawnSync} from 'node:child_process';
import {mkdirSync,readFileSync,existsSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
const root=fileURLToPath(new URL('../../',import.meta.url));
if(process.env.CI&&process.argv.includes('--candidate'))throw new Error('CI cannot bypass the engine pin');
const target=root+'outlayer/engine-v3/target/'+(process.argv.includes('--recheck')?'pinned-recheck':'pinned');mkdirSync(target,{recursive:true});
const args=['--host','unix:///var/run/docker.sock','run','--rm','-u','0','-v',root+':/home/near/code','-v',target+':/engine-target','-w','/home/near/code/outlayer/engine-v3','-e','CARGO_TARGET_DIR=/engine-target','-e','CARGO_INCREMENTAL=0','-e','RUSTUP_TOOLCHAIN=1.99.0'];
for(const key of ['HTTPS_PROXY','HTTP_PROXY','ALL_PROXY','NO_PROXY'])if(process.env[key])args.push('-e',key);
// Optional: a CA bundle for a TLS-intercepting proxy, mounted read-only.
if(process.env.TRUENAV_BUILD_CA_CERT)args.push('-v',process.env.TRUENAV_BUILD_CA_CERT+':/tmp/session-ca.pem:ro','-e','SSL_CERT_FILE=/tmp/session-ca.pem');
if(process.env.CARGO_HOME&&existsSync(process.env.CARGO_HOME+'/registry'))args.push('-v',process.env.CARGO_HOME+'/registry:/home/near/.cargo/registry');
args.push('sourcescan/cargo-near@sha256:51ab40efd798eae26c0dc71180909303f10bb4988b15ce3a18522c5be06e277e','bash','-c','rustup target add wasm32-wasip2 && cargo build --release --locked --target wasm32-wasip2 && chmod -R a+rX /engine-target');
const run=spawnSync('docker',args,{stdio:'inherit'});if(run.status!==0)process.exit(run.status??1);
const sha=createHash('sha256').update(readFileSync(target+'/wasm32-wasip2/release/truenav-engine-v3.wasm')).digest('hex');
console.log('Pinned engine sha256',sha);
if(!process.argv.includes('--candidate')&&sha!==JSON.parse(readFileSync(root+'receipts/v3-build.json')).engine.sha256)throw new Error('Pinned engine hash differs from v3-build.json');
