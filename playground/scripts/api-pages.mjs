import fs from 'node:fs';
const esc=s=>String(s??'').replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;');
const text=(v,lang)=>typeof v==='object'&&v!==null?(v[lang]??v.en??''):String(v??'');
const slug=s=>s.replace(/[^a-zA-Z0-9]+/g,'-').replace(/^-|-$/g,'');
const paths=['wgpu-kit','wgpu-kit/particles','wgpu-kit/grid','wgpu-kit/three','wgpu-kit/react','wgpu-kit/media','wgpu-kit/observe','wgpu-kit/vite'];
const url=p=>p==='wgpu-kit'?'/docs/api/':'/docs/api/'+p.split('/')[1]+'/';
const labels={en:{parameters:'Parameters',name:'Name',type:'Type',required:'Required',default:'Default',meaning:'Meaning',returns:'Returns',constraints:'Behavior & constraints',errors:'Errors & failure cases',members:'Members',fields:'Fields & related types',examples:'Examples',yes:'Yes',no:'No',none:'This call takes no arguments.',source:'Verified source',api:'API reference',guide:'Guides',contents:'On this page'},zh:{parameters:'参数',name:'名称',type:'类型',required:'必填',default:'默认值',meaning:'含义',returns:'返回值',constraints:'行为与约束',errors:'错误与失败情况',members:'成员',fields:'字段与关联类型',examples:'示例',yes:'是',no:'否',none:'此调用不接收参数。',source:'已核对的源码',api:'API 参考',guide:'指南',contents:'本页目录'}};
function params(rows,lang){const l=labels[lang];if(!rows.length)return`<p class="api-no-params">${l.none}</p>`;return`<div class="api-table-wrap"><table><thead><tr>${['name','type','required','default','meaning'].map(k=>`<th>${l[k]}</th>`).join('')}</tr></thead><tbody>${rows.map(p=>`<tr><td><code>${esc(p.name)}</code></td><td><code>${esc(p.type)}</code></td><td>${p.required===true?l.yes:p.required===false?l.no:esc(text(p.required,lang)||'—')}</td><td><code>${esc(text(p.default,lang)||'—')}</code></td><td>${esc(text(p.description,lang))}</td></tr>`).join('')}</tbody></table></div>`;}
function record(r,lang,parent='',level=2){const l=labels[lang],id=slug(parent?parent+'-'+r.name:r.name),tag='h'+Math.min(4,level);let html=`<section class="api-record ${level>2?'api-member':''}" id="${id}"><${tag}><a class="api-anchor" href="#${id}">${esc(r.name)}</a><span class="api-kind">${esc(r.kind??'')}</span></${tag}>`;
 if(r.description)html+=`<p>${esc(text(r.description,lang))}</p>`;
 if(r.signature)html+=`<pre data-language="typescript"><code>${esc(Array.isArray(r.signature)?r.signature.join('\n'):r.signature)}</code></pre>`;
 if(r.parameters)html+=`<h4>${l.parameters}</h4>${params(r.parameters,lang)}`;
 if(r.returns)html+=`<h4>${l.returns}</h4><p><code>${esc(r.returns.type??'')}</code> ${esc(text(r.returns.description,lang))}</p>`;
 for(const key of ['constraints','errors'])if(r[key]?.length)html+=`<h4>${l[key]}</h4><ul>${r[key].map(x=>`<li>${esc(text(x,lang))}</li>`).join('')}</ul>`;
 if(r.typeDetails?.length)html+=`<h4>${l.fields}</h4>${params(r.typeDetails,lang)}`;
 if(r.members?.length)html+=`<div class="api-members">${r.members.map(m=>record(m,lang,id,level+1)).join('')}</div>`;
 if(r.examples?.length)html+=`<h4>${l.examples}</h4>${r.examples.map(x=>`<figure class="api-example"><figcaption>${esc(text(x.caption,lang))}</figcaption><pre data-language="${esc(x.language??'typescript')}"><code>${esc(x.code)}</code></pre></figure>`).join('')}`;
 const sources=r.sourceUrls??r.sources;if(sources?.length)html+=`<p class="api-sources">${l.source}: ${sources.map((x,i)=>{const href=typeof x==='string'?x:x.url;return`<a href="${esc(href)}" target="_blank" rel="noopener">${i+1} ↗</a>`;}).join(' ')}</p>`;
 return html+'</section>';
}
export function buildApiPages({page,write,root,libraryVersion}){
 const files=fs.readdirSync(new URL('content/api/',root)).filter(x=>x.endsWith('.json'));const entries=files.flatMap(f=>JSON.parse(fs.readFileSync(new URL('content/api/'+f,root),'utf8')).entrypoints??[]);
 for(const path of paths){const entry=entries.find(e=>e.path===path);if(!entry)continue;const name=path==='wgpu-kit'?'Core':path.split('/')[1];
 const article=lang=>`<div class="api-intro"><p>${esc(text(entry.summary,lang))}</p><p class="api-version">${lang==='zh'?'依据已发布的 npm 2.0.0 声明与实现核对。只列出此入口实际导出的公开 API。':'Audited against published npm 2.0.0 declarations and implementation. Only actual public exports of this entry point are listed.'}</p></div>${entry.sourceUrls?.length?`<p class="api-sources">${labels[lang].source}: ${entry.sourceUrls.map((u,i)=>`<a href="${esc(u)}" target="_blank" rel="noopener">${i+1} ↗</a>`).join(' ')}</p>`:''}${entry.exports.map(r=>record(r,lang)).join('')}`;
 const sidebar=`<aside class="docs-sidebar api-sidebar"><a href="/docs/">Guides <span>↗</span></a><span class="sidebar-label">API REFERENCE</span>${paths.map(p=>`<a href="${url(p)}" ${p===path?'aria-current="page"':''}><code>${p}</code></a>`).join('')}<div class="sidebar-foot"><span>Exports</span></div>${entry.exports.map(r=>`<a href="#${slug(r.name)}"><code>${esc(r.name)}</code></a>`).join('')}</aside>`;
 const body=`<main id="main" class="docs-layout api-layout">${sidebar}<article class="docs-article"><div class="docs-top"><div><div class="eyebrow">API REFERENCE · ${libraryVersion}</div><h1>${esc(path)}</h1></div><button id="copy-docs" class="outline-button">⧉ Copy page</button></div><div id="api-content" data-no-translate>${article('en')}</div><template id="api-chinese">${article('zh')}</template></article><aside class="docs-toc"><strong>On this page</strong>${entry.exports.map(r=>`<a href="#${slug(r.name)}"><code>${esc(r.name)}</code></a>`).join('')}<hr><a href="#main">↑ Scroll to top</a></aside></main>`;
 write('dist'+url(path)+'index.html',page(name+' API reference',body,'docs','documentation api-reference-page'));
 }
 const search=[];for(const entry of entries)for(const r of entry.exports){search.push([r.name,text(r.description,'en'),url(entry.path)+'#'+slug(r.name),text(r.description,'zh'),r.signature??'']);for(const m of r.members??[])search.push([r.name+'.'+m.name,text(m.description,'en'),url(entry.path)+'#'+slug(r.name+'-'+m.name),text(m.description,'zh'),m.signature??'']);}write('dist/api-search.json',JSON.stringify(search));
 return entries;
}
