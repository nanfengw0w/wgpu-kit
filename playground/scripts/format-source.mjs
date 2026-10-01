import fs from 'node:fs';
import prettier from 'prettier';
import * as wgslPlugin from 'prettier-plugin-wgsl';
import ts from 'typescript';
import {build} from 'esbuild';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { outputPath, showcaseRoot } from './paths.mjs';
const root=new URL('../',import.meta.url);
const options={parser:'typescript',printWidth:88,tabWidth:2,useTabs:false,singleQuote:true,trailingComma:'all'};
export async function readableSource(input,language='typescript'){
  if(!input.trim())return input;
  if(['bash','shell','sh'].includes(language)||/^\s*(?:npm|pnpm|yarn|bun|npx|cd|git)\s/.test(input))return input.trim();
  if(language==='wgsl'||/^\s*(?:@(?:compute|group|vertex|fragment)|fn\s+\w+)/.test(input))return (await prettier.format(input,{parser:'wgsl',plugins:[wgslPlugin],printWidth:88,tabWidth:2})).trimEnd();
  let code=input;
  const source=ts.createSourceFile('sample.ts',code,ts.ScriptTarget.Latest,true,ts.ScriptKind.TS);
  const edits=[];
  const walk=node=>{if(ts.isTemplateExpression(node)&&node.templateSpans.length===1&&/\bfn\s+\w+/.test(node.templateSpans[0].literal.text))edits.push(node);if(ts.isNoSubstitutionTemplateLiteral(node)&&/\b(?:fn\s+\w+\s*\(|struct\s+\w+\s*\{)/.test(node.text)){edits.push(node);}ts.forEachChild(node,walk);};walk(source);
  for(const node of edits.reverse()){
    const body=ts.isTemplateExpression(node)?node.templateSpans[0].literal.text:node.text;
    const formatted=await prettier.format(body,{parser:'wgsl',plugins:[wgslPlugin],printWidth:84,tabWidth:2});
    const prefix=ts.isTemplateExpression(node)?'${'+node.templateSpans[0].expression.getText(source)+'}\n':'';
    const value='`\n'+prefix+formatted.trimEnd().split('\n').map(line=>'    '+line).join('\n')+'\n  `';
    code=code.slice(0,node.getStart(source))+value+code.slice(node.end);
  }
  try{return (await prettier.format(code,{...options,parser:language==='tsx'?'typescript':language==='javascript'?'babel':'typescript'})).trimEnd();}
  catch(error){
    // API method declarations are valid inside their owning class/interface.
    for(const wrapper of ['interface Api {','declare class Api {']){try{const full=await prettier.format(wrapper+'\n'+code+'\n}',options);return full.split('\n').slice(1,-2).map(line=>line.replace(/^  /,'')).join('\n').trimEnd();}catch{}}
    // Already-short partial signatures are kept exact; long unformatted code is an error.
    if(code.split('\n').every(line=>line.length<105))return code.trim();
    // Display-only constructor/qualified signatures are not standalone TS programs.
    // Break the outer parameter list without altering any token.
    const open=code.indexOf('('),close=code.lastIndexOf(')');
    if(open>=0&&close>open){let depth=0,braces=0,angles=0,part='',rows=[];for(const ch of code.slice(open+1,close)){if(ch==='('||ch==='[')depth++;if(ch===')'||ch===']')depth--;if(ch==='{')braces++;if(ch==='}')braces--;if(ch==='<')angles++;if(ch==='>'&&angles>0)angles--;if(ch===','&&depth===0&&braces===0&&angles===0){rows.push(part.trim());part='';}else part+=ch;}if(part.trim())rows.push(part.trim());return code.slice(0,open+1)+'\n'+rows.map(row=>'  '+row).join(',\n')+'\n'+code.slice(close);}
    throw new Error('Cannot format source: '+code.slice(0,120));
  }
}
export async function formatAllSources(){
  const entries=['examples','labs','tactile'];
  if(fs.existsSync(new URL('src/gpu/materials.ts',root)))entries.push('materials');
  if(fs.existsSync(new URL('src/gpu/silk.ts',root)))entries.push('silk');
  const contents=entries.map(name=>`export * from './src/gpu/${name}.ts';`).join('\n');
  const tempRoot=outputPath('.build');const out=pathToFileURL(path.join(tempRoot,'source-samples.mjs'));fs.mkdirSync(tempRoot,{recursive:true});
  await build({stdin:{contents,resolveDir:showcaseRoot,loader:'ts'},bundle:true,platform:'node',format:'esm',outfile:path.join(tempRoot,'source-samples.mjs'),logLevel:'silent'});
  const samples=await import(out.href+'?time='+Date.now());let all={};for(const[key,value]of Object.entries(samples))if(key.endsWith('_SOURCES'))Object.assign(all,value);
  if(fs.existsSync(new URL('src/gpu/silk.ts',root)))all['silk-cloth']=fs.readFileSync(new URL('src/gpu/silk.ts',root),'utf8');
  all['gravitational-lens']=fs.readFileSync(new URL('src/gpu/gravitational-lens.ts',root),'utf8');
  all['sculpted-ribbon']=fs.readFileSync(new URL('src/gpu/hero.ts',root),'utf8');
  const result={};for(const[id,source]of Object.entries(all))result[id]=await readableSource(source);
  fs.writeFileSync(new URL('content/formatted-sources.json',root),JSON.stringify(result,null,2)+'\n');
  const decode=s=>s.replaceAll('&lt;','<').replaceAll('&gt;','>').replaceAll('&quot;','"').replaceAll('&#39;',"'").replaceAll('&amp;','&');
  const escape=s=>s.replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;');
  let blocks=0;
  const walk=async dir=>{for(const entry of fs.readdirSync(dir,{withFileTypes:true})){const p=new URL(entry.name+(entry.isDirectory()?'/':''),dir);if(entry.isDirectory()){await walk(p);continue;}if(entry.name!=='index.html')continue;let html=fs.readFileSync(p,'utf8');const matches=[...html.matchAll(/<pre([^>]*)>([\s\S]*?)<\/pre>/g)];for(const match of matches.reverse()){let body=match[2];if(!body.trim())continue;const code=body.match(/^<code([^>]*)>([\s\S]*)<\/code>$/);const attrs=match[1]+(code?.[1]??'');const raw=decode(code?.[2]??body);const lang=attrs.match(/(?:data-language="|language-)([\w-]+)/)?.[1];const formatted=await readableSource(raw,lang);const replacement='<pre'+match[1]+'>'+(code?'<code'+code[1]+'>':'')+escape(formatted)+(code?'</code>':'')+'</pre>';html=html.slice(0,match.index)+replacement+html.slice(match.index+match[0].length);blocks++;}fs.writeFileSync(p,html);}};
  await walk(pathToFileURL(outputPath()+path.sep));
  // Downloaded modules are source code too, so format their TypeScript and shader literals.
  for(const name of ['hero','examples','labs','cosmic','tactile','materials','silk','gravitational-lens']){const file=new URL('src/gpu/'+name+'.ts',root);if(!fs.existsSync(file))continue;const input=fs.readFileSync(file,'utf8');const formatted=await readableSource(input);fs.writeFileSync(outputPath('source/'+name+'.ts'),formatted+'\n');}
  fs.rmSync(tempRoot,{recursive:true,force:true});
  console.log(`Formatted ${Object.keys(result).length} example sources and ${blocks} documentation code blocks`);
}
