#!/usr/bin/env node
import {isMain} from './native/is-main.mjs';

export async function run(args=process.argv.slice(2)){
  const [command,...rest]=args;
  if(command==='remote'||command==='legacy'){
    const {runLegacy}=await import('./legacy-cli.mjs');
    return runLegacy(rest);
  }
  const {runLocal}=await import('./native/local-cli.mjs');
  return runLocal(command==='local'||command==='http'?rest:args);
}

if(isMain(import.meta.url)){
  try{await run();}
  catch(error){
    console.error(`${error.code||'ERROR'}：${error.message}`);
    process.exitCode=1;
  }
}
