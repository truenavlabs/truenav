// Compile locally only. No deployment or signing.
import solc from 'solc';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
const content=await readFile(new URL('./contracts/TrueNavMirror.sol',import.meta.url),'utf8');
const input={language:'Solidity',sources:{'TrueNavMirror.sol':{content}},settings:{evmVersion:'shanghai',optimizer:{enabled:true,runs:200},outputSelection:{'*':{'*':['abi','evm.bytecode.object','evm.deployedBytecode.object']}}}};
const output=JSON.parse(solc.compile(JSON.stringify(input)));
if(output.errors?.some(e=>e.severity==='error'))throw Error('Solidity compilation failed');
const artifact=output.contracts['TrueNavMirror.sol'].TrueNavMirror;
const dir=new URL('../out/mirror/',import.meta.url);await mkdir(dir,{recursive:true});
await writeFile(new URL('TrueNavMirror.json',dir),JSON.stringify({compiler:solc.version(),input,abi:artifact.abi,bytecode:'0x'+artifact.evm.bytecode.object,deployedBytecode:'0x'+artifact.evm.deployedBytecode.object},null,2)+'\n');
console.log('Compiled local mirror artifact: out/mirror/TrueNavMirror.json');
