/* Reproduces the state every phone was left in after the tables were
   truncated and the real roster imported, and checks the app digs itself out. */
const {ids,doc,store,loadApp}=require('./domstub.js');
let P=0,F=0;
const chk=(n,c,e)=>{if(c){P++;console.log('  PASS  '+n);}else{F++;
  console.log('  FAIL  '+n+(e!==undefined?'   -> '+JSON.stringify(e):''));}};

const DAYS=[{id:1,event_date:'2026-09-14',day_no:1,
  menu_label:'Live Dhokla with Chutney',plate_rate:60,is_open:true}];
const HOUSES=[
 {id:501,house_code:'B-34',wing_group:'B',number_label:'34',sort_order:34,
  family_name:'Mahendrabhai M. Mistri',member_count:2,is_active:true,
  updated_at:'2026-09-10T10:00:00Z'},
 {id:502,house_code:'C-4',wing_group:'C',number_label:'4',sort_order:4,
  family_name:'Karan Patel',member_count:4,is_active:true,
  updated_at:'2026-09-10T10:00:00Z'}];
const SERVINGS=[{id:1,house_id:501,event_date:'2026-09-14',qty:2,is_extra:false,
  is_guest:false,served_at:'2026-09-14T19:30:00Z',client_uid:'srv-1'}];
const CONTRIB=[{id:1,house_id:501,purpose:'food',event_date:'2026-09-14',qty:2,
  amount:120,mode:'cash',receipt_series:'X',receipt_no:1,collected_by:'import',
  collected_at:'2026-09-10T10:00:00Z',client_uid:'imp-f-1',collection_uid:'c1'}];
const POSTED=[];
global.fetch=async(url,opts)=>{
  opts=opts||{};
  const ok=b=>({ok:true,status:200,json:async()=>b,text:async()=>JSON.stringify(b)});
  if(url.includes('/auth/v1/token')) return ok({access_token:'AT',refresh_token:'RT',
    expires_in:3600,user:{id:'u1',email:'counter1@ganesh.local'}});
  const m=url.match(/\/rest\/v1\/([a-z_]+)/); const t=m?m[1]:'';
  if(opts.method==='POST'){
    const rows=JSON.parse(opts.body);
    if(t==='servings' && rows.some(r=>r.house_id===999)){
      return {ok:false,status:409,text:async()=>
        'HTTP 409 violates foreign key constraint "servings_house_id_fkey"'};
    }
    POSTED.push(...rows);
    return ok(rows.map((r,i)=>Object.assign({},r,{id:900+POSTED.length+i})));
  }
  if(t==='profiles') return ok([{id:'u1',display_name:'Counter 1',role:'volunteer',
    receipt_series:'A',can_collect:true,can_expense:false}]);
  if(t==='app_settings') return ok([{id:1,receipt_prefix:'GU26',extra_plate_rate:60,
    currency_symbol:'Rs',allow_extra_plates:true}]);
  if(t==='event_days') return ok(DAYS);
  if(t==='expense_categories') return ok([]);
  if(t==='houses'){
    if(url.includes('select=id')) return ok(HOUSES.map(h=>({id:h.id})));
    if(url.includes('select=*')) return ok(HOUSES);
    const c=decodeURIComponent((url.match(/updated_at=gt\.([^&]+)/)||[,''])[1]);
    return ok(HOUSES.filter(h=>h.updated_at>c));
  }
  if(t==='servings'){
    if(url.includes('order=id.desc')) return ok([{id:1}]);
    const c=Number((url.match(/id=gt\.(\d+)/)||[,0])[1]);
    return ok(SERVINGS.filter(r=>r.id>c));
  }
  if(t==='contributions'){
    if(url.includes('order=receipt_no.desc')) return ok([{receipt_no:1}]);
    if(url.includes('order=id.desc')) return ok([{id:1}]);
    const c=Number((url.match(/id=gt\.(\d+)/)||[,0])[1]);
    return ok(CONTRIB.filter(r=>r.id>c));
  }
  if(t==='expenses'){ if(url.includes('order=id.desc')) return ok([]); return ok([]); }
  return ok([]);
};
global.window.GANESH_CONFIG={SUPABASE_URL:'https://x.supabase.co',SUPABASE_ANON:'k',
  POLL_SECONDS:9999,QTY_BUTTONS:[1,2,3,4,5],UNDO_WINDOW_SECONDS:900};
store['gu.v1.session']=JSON.stringify({at:'AT',rt:'RT',exp:Date.now()+3600e3,
  user:{id:'u1',email:'counter1@ganesh.local'}});
// ---- exactly the stale state a phone was left in ----
store['gu.v1.cursors']=JSON.stringify({servings:17,contributions:9,expenses:1,
  houses:'2026-09-05T00:00:00Z',cats:'1970-01-01T00:00:00Z'});
store['gu.v1.houses']=JSON.stringify([{id:101,house_code:'A-1',wing_group:'AB',
  number_label:'1',sort_order:1,family_name:'OLD PLACEHOLDER',member_count:4,
  is_active:true}]);
store['gu.v1.servings']=JSON.stringify([{id:11,house_id:101,event_date:'2026-09-14',
  qty:4,is_extra:false,is_guest:false,served_at:'2026-09-05T19:00:00Z',
  client_uid:'stale-1'}]);
store['gu.v1.queue']=JSON.stringify({servings:[{house_id:999,
  event_date:'2026-09-14',qty:1,is_extra:false,is_guest:false,
  served_at:'2026-09-05T19:00:00Z',client_uid:'poison-1',_local:true,action_id:'a1'}],
  contributions:[],expenses:[]});
loadApp();
const sleep=ms=>new Promise(r=>setTimeout(r,ms));

(async()=>{
  await doc._listeners.DOMContentLoaded(); await sleep(500);
  const houses=JSON.parse(store['gu.v1.houses']);
  const servings=JSON.parse(store['gu.v1.servings']);
  const cursors=JSON.parse(store['gu.v1.cursors']);
  const queue=JSON.parse(store['gu.v1.queue']);
  const rejected=JSON.parse(store['gu.v1.rejected']||'[]');

  console.log('=== 1. the cursor noticed the tables were reset ===');
  chk('servings cursor rewound then re-advanced to 1', cursors.servings===1, cursors.servings);
  chk('stale cached serving discarded',
      !servings.some(r=>r.client_uid==='stale-1'), servings.map(r=>r.client_uid));
  chk('the imported serving arrived',
      servings.some(r=>r.client_uid==='srv-1'), servings.map(r=>r.client_uid));

  console.log('\n=== 2. roster reconciled, deleted houses dropped ===');
  chk('OLD PLACEHOLDER gone',
      !houses.some(h=>h.family_name==='OLD PLACEHOLDER'), houses.map(h=>h.house_code));
  chk('real roster loaded',
      houses.length===2 && houses.some(h=>h.house_code==='B-34'),
      houses.map(h=>h.house_code));
  chk('B-34 carries its real family name',
      (houses.find(h=>h.house_code==='B-34')||{}).family_name==='Mahendrabhai M. Mistri');

  console.log('\n=== 3. an unsaveable row does not jam the queue ===');
  chk('queue drained', (queue.servings||[]).length===0, (queue.servings||[]).length);
  chk('bad row quarantined rather than lost',
      rejected.length===1 && rejected[0].client_uid==='poison-1',
      rejected.map(r=>r.client_uid));
  chk('reason recorded', !!(rejected[0]||{})._error, (rejected[0]||{})._error);

  console.log('\n=== 4. B-34 now serves against the imported pass ===');
  ids['search'].oninput({target:{value:'B-34'}});
  chk('B-34 on the grid', ids['house-grid'].children.length===1,
      ids['house-grid'].children.length);
  ids['house-grid'].children[0].click();
  chk('sheet opened on B-34', ids['sh-code']._text==='B-34', ids['sh-code']._text);
  chk('2 paid for today', ids['sh-members']._text==='2', ids['sh-members']._text);
  chk('2 already taken', ids['sh-today']._text==='2', ids['sh-today']._text);
  chk('0 left', ids['sh-left']._text==='0', ids['sh-left']._text);

  console.log('\n  '+P+' passed, '+F+' failed');
  process.exit(F?1:0);
})().catch(e=>{console.error('CRASH',e);process.exit(2);});
