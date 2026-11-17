/* Deterministic rendering checks: real bundled KaTeX, no live model or browser. */
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),assert=require('node:assert/strict');
const assets=path.resolve(__dirname,'../assets/game-runtime');
const source=fs.readFileSync(path.join(assets,'app.js'),'utf8');
const katex=require(path.join(assets,'vendor/katex.min.js'));
class Node{
 constructor(tag,text=''){this.tag=tag;this.children=[];this._text=text;this.attributes={};}
 append(...children){this.children.push(...children);}
 replaceChildren(){this.children=[];this._text='';}
 set textContent(value){this._text=String(value);this.children=[];}
 get textContent(){return this._text+this.children.map(child=>child.textContent).join('');}
 setAttribute(key,value){this.attributes[key]=String(value);}
}
let formulaCount=0;
const game={levels:[{id:'notation',type:'convention',equations:[{index:1,references:['eq:one']}]},{id:'claim',type:'statement',equations:[]},{id:'proof',type:'proof',equations:[]}],references:[{key:'Author',aliases:['Author'],file:'references/Author.pdf',title:'A reference',pages:10,default_page:1}],internal_references:{'eq:one':{level_id:'notation',number:'1.1',name:'Equation'},'thm:claim':{level_id:'claim',number:'1.1',name:'Theorem'},'proof:claim':{level_id:'proof',number:'2.1',name:'Section'}}};
const available=new Set(['notation','claim']);
const context={homePath:'/',state:{game},document:{createTextNode:text=>new Node('#text',text)},element:(tag,cls,text)=>Object.assign(new Node(tag,text),{className:cls}),language:()=> 'English',kindName:kind=>kind,t:key=>({lockedShort:'Locked'}[key]||key),levelStatus:()=>({available}),window:{katex:{render:(text,node,options)=>{katex.renderToString(text,options);formulaCount++;node.math=text;}}}};
vm.createContext(context);
vm.runInContext(source.slice(source.indexOf('  function referenceTarget'),source.indexOf('  function notice'))+';this.render=renderRich;',context);
const all=(node,predicate)=>[...(predicate(node)?[node]:[]),...node.children.flatMap(child=>all(child,predicate))];
function render(text,options){const node=new Node('div');context.render(node,text,options);assert(!/[\uE000-\uE103]/.test(node.textContent),'render tokens leaked');assert.equal(all(node,x=>x.className==='formula-fallback').length,0,'KaTeX rendering failed');return node;}
let checks=0;
for(const text of ['the **flow acting on $f$**.','**first \\(x\\), then \\(y\\)**','__a formula $f$ inside emphasis__','**first line\ncontinues with $f$**']){
 const node=render(text),strong=all(node,x=>x.tag==='strong');
 assert.equal(strong.length,1);assert(all(strong[0],x=>Boolean(x.math)).length);assert(!node.textContent.includes('**'));checks++;
}
for(const [text,href,label] of [['See \\eqref{eq:one}.','/?level=notation&ref=eq%3Aone','(1.1)'],['By \\autoref{thm:claim}.','/?level=claim&ref=thm%3Aclaim','Theorem 1.1'],['**Theorem \\ref{thm:claim}**','/?level=claim&ref=thm%3Aclaim','1.1']]){
 const links=all(render(text),x=>x.tag==='a');assert.equal(links.length,1);assert.equal(links[0].href,href);assert.equal(links[0].textContent,label);assert.equal(links[0].target,'_self');checks++;
}
const locked=render('See Section \\ref{proof:claim}.');assert.equal(all(locked,x=>x.tag==='a').length,0);assert(locked.textContent.includes('Locked'));assert.equal(all(locked,x=>x.attributes['aria-disabled']==='true').length,1);checks++;
available.add('proof');assert.equal(all(render('See \\ref{proof:claim}.'),x=>x.tag==='a').length,1);checks++;
assert.equal(all(render('See \\ref{unknown}.'),x=>x.tag==='a').length,0);checks++;
const equation=render('\\begin{equation}x+y=1\\label{eq:one}\\end{equation}',{levelId:'notation'});
assert.equal(all(equation,x=>x.className==='numbered-equation').length,1);assert.equal(all(equation,x=>x.id==='ref-eq%3Aone').length,1);assert(equation.textContent.includes('(1.1)'));checks++;
const tutorEquation=render('\\[a+b=c\\]',{macroLevelId:'notation'});
assert.equal(all(tutorEquation,x=>x.className==='numbered-equation').length,0);
assert(!tutorEquation.textContent.includes('(1.1)'));checks++;
const tutorReference=render('See \\eqref{eq:one}.',{macroLevelId:'notation'});
assert.equal(all(tutorReference,x=>x.tag==='a')[0].textContent,'(1.1)');checks++;
for(const [text,expected] of [['Author, Theorem 2',['/references/Author.pdf#page=1']],['[Author](/references/Author.pdf#page=5)',['/references/Author.pdf#page=5']],['[fake](/references/secret.pdf)',[]],['[Author](/references/Author.pdf#page=99)',[]],['Authorland',[]],['`Author`',[]]]){
 const links=all(render(text),x=>x.tag==='a');assert.deepEqual(links.map(x=>x.href),expected);links.forEach(link=>{assert.equal(link.target,'_blank');assert.equal(link.rel,'noopener noreferrer');});checks++;
}
game.references.push({key:'Example',aliases:['Ada Example','Example'],file:'references/Example.pdf',title:'A cited result',authors:'Ada Example',pages:5,default_page:1});
for(const [text,expected] of [['a simple example',[]],['Example proved this.',['/references/Example.pdf#page=1']],['Ada Example proved this.',['/references/Example.pdf#page=1']],['[example](/references/Example.pdf#page=2)',['/references/Example.pdf#page=2']]]){
 const links=all(render(text),x=>x.tag==='a');assert.deepEqual(links.map(x=>x.href),expected);checks++;
}
// A cited PDF can have one default page and several independently verified result pages.
game.references.push({key:'paper',aliases:['paper'],file:'references/paper.pdf',title:'A cited paper',pages:20,default_page:12,
 locations:[{label:'Projective change of variables (Theorem 4.10 and proof)',match:'Projective change of variables',page:12},
            {label:'Theorem 1.2',match:'Theorem 1\\.2',page:2},
            {label:'Theorems 17.14 and 17.26, shared hypotheses',page:9},
            {label:'Theorem 17.14',page:15},{label:'Theorem 1.2(a)(i)',page:7}]});
game.references.push({key:'other-work',aliases:['other-work'],file:'references/other-work.pdf',title:'Another paper',pages:10,default_page:3,
 locations:[{label:'Proof of Theorem 1.2, printed page 4',match:'Proof of Theorem 1\\.2, printed page 4',page:6}]});
for(const [text,expected] of [
 ['See \\cite{paper}, Theorem 1.2.',['/references/paper.pdf#page=2']],
 ['See \\cite{paper}*{Theorem 1.2}.',['/references/paper.pdf#page=2']],
 ['参见 \\cite{paper}，定理~1.2。',['/references/paper.pdf#page=2']],
 ['See \\cite{paper}, Theorem 4.10, and \\cite{other-work}, Theorem 1.2.',['/references/paper.pdf#page=12','/references/other-work.pdf#page=6']],
 ['See \\cite{paper} and \\cite{other-work}, Theorem 1.2.',['/references/paper.pdf#page=12','/references/other-work.pdf#page=6']],
 ['See \\cite{paper}, Theorems 17.14 and 17.26.',['/references/paper.pdf#page=15']],
 ['See \\cite{paper}, Theorem 1.2(a)(i).',['/references/paper.pdf#page=7']],
 ['See \\cite{paper}, Theorem 1.2(a)(ii).',['/references/paper.pdf']],
 ['See \\cite{paper}, Theorem 1.20.',['/references/paper.pdf']],
]){
 const links=all(render(text),x=>x.tag==='a');assert.deepEqual(links.map(x=>x.href),expected,text);checks++;
}
const citedPaper=game.references.find(ref=>ref.key==='paper');
citedPaper.locations.push({label:'Theorem  17.14',page:16});
assert.deepEqual(all(render('See \\cite{paper}, Theorem 17.14.'),x=>x.tag==='a').map(x=>x.href),['/references/paper.pdf']);checks++;
citedPaper.locations.pop();
for(const text of ['\\begin{alignat}{2}x&=1 &\\quad y&=2\\end{alignat}','\\begin{flalign}x&=1 & y&=2\\end{flalign}','\\begin{alignat*}{1}x&=1\\end{alignat*}']){
 const node=render(text);assert.equal(all(node,x=>Boolean(x.math)).length,1);assert(!node.textContent.includes('begin{'));checks++;
}
const formatted=render('\\paragraph{A heading}\\textbf{a formula $x$} and \\emph{emphasis}, 10\\%.');
assert.equal(all(formatted,x=>x.tag==='h4').length,1);assert.equal(all(formatted,x=>x.tag==='strong').length,1);assert.equal(all(formatted,x=>x.tag==='em').length,1);assert(formatted.textContent.includes('10%'));assert(!formatted.textContent.includes('textbf'));checks++;
const theorem=render('\\begin{Theorem}[A test]\\label{thm:claim}\nFor $x=1$, see \\eqref{eq:one}.\\end{Theorem}',{levelId:'claim'});
assert.equal(all(theorem,x=>x.id==='ref-thm%3Aclaim').length,1);assert.equal(all(theorem,x=>x.tag==='h4').length,1);checks++;
game.math_macros={'\\symbol':'\\mathbb{R}'};
const originalRender=context.window.katex.render;
let macroValue;
context.window.katex.render=(text,node,options)=>{macroValue=options.macros['\\symbol'];originalRender(text,node,options);};
render('$\\symbol$',{levelId:'claim'});
assert.equal(macroValue,'\\mathbb{R}');checks++;
console.log(JSON.stringify({ok:true,rendering_cases:checks,actual_katex_fragments:formulaCount}));
