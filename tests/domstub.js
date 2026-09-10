/* A DOM small enough to run app.js under plain node, so the money logic can be
   tested without a browser. It does NOT parse innerHTML into child nodes, so
   tests should locate controls by class or tag rather than by child index. */
const ids = {};
function mkEl(tag) {
  const e = {
    tagName:(tag||'div').toUpperCase(), _text:'', _html:'', value:'', hidden:false,
    disabled:false, checked:false, children:[], options:[], dataset:{}, style:{},
    scrollTop:0, files:null, src:'', href:'', download:'', type:'',
    _cls:new Set(), onclick:null, oninput:null, onchange:null, onsubmit:null,
    classList:{ add:c=>e._cls.add(c), remove:c=>e._cls.delete(c),
      toggle:(c,on)=>{on?e._cls.add(c):e._cls.delete(c);}, contains:c=>e._cls.has(c) },
    appendChild(c){e.children.push(c); return c;},
    remove(){}, addEventListener(k,f){e['on'+k]=f;},
    click(){ if(e.onclick) e.onclick({stopPropagation(){},preventDefault(){}}); },
    getContext:()=>({drawImage(){}}), toDataURL:()=>'data:image/jpeg;base64,AAA'
  };
  Object.defineProperty(e,'className',{get:()=>[...e._cls].join(' '),
    set:v=>{e._cls=new Set(String(v).split(/\s+/).filter(Boolean));}});
  Object.defineProperty(e,'textContent',{get:()=>e._text,set:v=>{e._text=String(v);}});
  Object.defineProperty(e,'innerHTML',{get:()=>e._html,set:v=>{e._html=String(v);e.children=[];}});
  return e;
}
const doc = {
  _listeners:{}, hidden:false, activeElement:null,
  getElementById(id){ return ids[id] || (ids[id]=mkEl('div')); },
  createElement:mkEl,
  querySelector(sel){ return sel==='.tab.active' ? ids['tab-serve'] : mkEl('div'); },
  querySelectorAll(sel){
    if(sel==='.tab') return ['serve','collect','expense','live','more'].map(t=>ids['tab-'+t]);
    if(sel==='.bottom-nav button') return ['serve','collect','expense','live','more'].map(t=>{
      const b=mkEl('button'); b.dataset.tab=t; return b; });
    return [];
  },
  addEventListener(k,f){ doc._listeners[k]=f; }
};
const fs=require('fs'), path=require('path');
const APPDIR = process.env.APPDIR || path.join(__dirname,'..');
const html=fs.readFileSync(path.join(APPDIR,'index.html'),'utf8');
for (const m of html.matchAll(/<([a-z0-9]+)\s+([^>]*)id="([^"]+)"([^>]*)>/gi)) {
  const attrs=m[2]+' '+m[4]; const e=mkEl(m[1]);
  if(/\bhidden\b/.test(attrs)) e.hidden=true;          // honour the HTML attribute
  if(/class="([^"]*)"/.test(attrs)) e.className=RegExp.$1;
  ids[m[3]]=e;
}
const store={};
global.localStorage={getItem:k=>(k in store?store[k]:null),
  setItem:(k,v)=>{store[k]=String(v);}, removeItem:k=>{delete store[k];}};
global.document=doc; global.window={addEventListener(){},GANESH_CONFIG:null};
global.navigator={onLine:true,vibrate(){}};
let n=1; global.crypto={randomUUID:()=>'uid-'+(n++)};
global.Image=function(){const s=this;setTimeout(()=>s.onload&&s.onload(),0);};
global.FileReader=function(){}; global.Blob=function(){};
global.URL={createObjectURL:()=>'blob:x',revokeObjectURL(){}};
global.confirm=()=>true; global.prompt=()=>'3'; global.alert=()=>{};
function loadApp(){
  const vm=require('vm');
  vm.runInThisContext(fs.readFileSync(path.join(APPDIR,'app.js'),'utf8'),{filename:'app.js'});
}
module.exports={ids,doc,store,mkEl,loadApp,APPDIR};
