import Prism from 'prismjs';
import 'prismjs/components/prism-typescript';
import 'prismjs/components/prism-jsx';
import 'prismjs/components/prism-tsx';
import 'prismjs/components/prism-bash';
Prism.manual=true;
const wgsl:Prism.Grammar={
 comment:[{pattern:/\/\*[\s\S]*?(?:\*\/|$)/,greedy:true},{pattern:/\/\/[^\r\n]*/,greedy:true}],
 attribute:{pattern:/@[a-z_]\w*/i,alias:'builtin'},
 keyword:/\b(?:alias|break|case|const|const_assert|continue|continuing|default|diagnostic|discard|else|enable|false|fn|for|if|let|loop|override|requires|return|struct|switch|true|var|while)\b/,
 'class-name':/\b(?:array|atomic|bool|f16|f32|i32|u32|mat[234]x[234][fh]?|vec[234][fiuh]?|ptr|sampler|sampler_comparison|texture_\w+)\b/,
 number:/\b(?:0x[\da-f]+(?:\.[\da-f]*)?(?:p[+-]?\d+)?|\d+(?:\.\d*)?(?:e[+-]?\d+)?)[fhiu]?\b|\.\d+(?:e[+-]?\d+)?[fh]?/i,
 function:/\b[a-z_]\w*(?=\s*\()/i,
 operator:/--|\+\+|&&|\|\||<<|>>|->|[-+*/%&|^!=<>]=?|[~?:]/,
 punctuation:/[{}[\];(),.:]/
};
Prism.languages.wgsl=wgsl;
Prism.languages.insertBefore('typescript','template-string',{'wgsl-code':{pattern:/(\bcode\s*:\s*)`(?:\\[\s\S]|[^`\\])*`/,lookbehind:true,greedy:true,inside:{'template-punctuation':{pattern:/^`|`$/,alias:'string'},...wgsl}}});
export function languageOf(code:string,explicit?:string){if(explicit)return explicit==='ts'?'typescript':explicit==='js'?'javascript':['sh','shell'].includes(explicit)?'bash':explicit;return /^\s*(npm|pnpm|yarn|bun|npx|cd|git)\s/.test(code)?'bash':/^\s*(?:@(?:compute|group|vertex|fragment)|fn\s+\w+)/.test(code)?'wgsl':'typescript';}
export function highlightSource(code:string,language='typescript'){return Prism.highlight(code,Prism.languages[language]??Prism.languages.typescript,language);}
export function highlightPre(pre:HTMLElement){const existing=pre.querySelector('code');const raw=pre.dataset.rawCode??existing?.textContent??pre.textContent??'';pre.dataset.rawCode=raw;const lang=languageOf(raw,pre.dataset.language??existing?.className.match(/language-([\w-]+)/)?.[1]);let code=existing;if(!code){pre.replaceChildren();code=document.createElement('code');pre.append(code);}code.className='language-'+lang;code.innerHTML=highlightSource(raw,lang);return raw;}
