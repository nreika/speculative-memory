// External scenario submission page (/submit/). Check = validate only; Submit = queue for the operator (never plays).
const $=id=>document.getElementById(id);
const LIMITS={csv:2*1024*1024,image:5*1024*1024,images:5};
let busy=false;
function show(kind,title,text='',rows=[]){
  $('result').hidden=false;$('result').className=kind;$('result-title').textContent=title;$('result-text').textContent=text;
  $('result-list').replaceChildren(...rows.slice(0,30).map(r=>{const li=document.createElement('li');li.textContent=r;return li;}));
}
const issue=w=>`${w.row?'row '+w.row:'file'}${w.column?' ['+w.column+']':''}: ${w.message}${w.text?'  ⟶  '+w.text:''}`;
function localCheck(){
  const name=$('name').value.trim(),csv=$('csv').files[0],images=[...$('images').files];
  if(!name)return 'Enter your name.';
  if(name.length>40)return 'Name: at most 40 characters.';
  if($('note').value.trim().length>200)return 'Note: at most 200 characters.';
  if(!csv)return 'Choose a scenario CSV.';
  if(!csv.name.toLowerCase().endsWith('.csv'))return 'The scenario file must be a .csv.';
  if(csv.size>LIMITS.csv)return 'CSV exceeds 2 MB.';
  if(images.length>LIMITS.images)return 'At most 5 images.';
  const big=images.find(f=>f.size>LIMITS.image);if(big)return `${big.name} exceeds 5 MB.`;
  return '';
}
async function send(mode){
  if(busy)return;const problem=localCheck();if(problem)return show('error','Not sent',problem);
  busy=true;$('check').disabled=$('submit').disabled=true;show('',mode==='check'?'Checking…':'Sending…');
  const form=new FormData();form.append('mode',mode);form.append('name',$('name').value.trim());form.append('note',$('note').value.trim());
  form.append('csv',$('csv').files[0]);for(const f of $('images').files)form.append('images',f);
  try{
    const response=await fetch('/api/scenario-submit',{method:'POST',headers:{'X-Submit-Request':'1'},body:form,credentials:'same-origin',cache:'no-store'});
    let data;try{data=await response.json();}catch{data={ok:false,error:`Request failed (${response.status})`};}
    if(!response.ok||!data.ok){
      const rows=[...(data.formatErrors||[]).map(issue),...(data.formatWarnings||[]).map(w=>'warning · '+issue(w))];
      return show('error',response.status===429?'Too many requests':response.status===401?'Link required':'Not accepted',data.error||`Request failed (${response.status})`,rows);
    }
    const warnings=(data.warnings||[]).map(issue);
    if(mode==='check')return show(warnings.length?'warn':'ok',warnings.length?`Format OK with ${warnings.length} warning${warnings.length===1?'':'s'}`:'Format OK',`Scenario ${data.scenarioId||''} passed the check. Nothing was saved yet — press Submit to send it.`,warnings);
    show('ok','Submitted',`Thank you. Scenario ${data.scenarioId||''} is queued for the operator (reference ${String(data.id).slice(0,8)}). It plays only after the operator approves it.`,warnings);
    $('form').reset();
  }catch(error){show('error','Not sent',String(error?.message||error));}
  finally{busy=false;$('check').disabled=$('submit').disabled=false;}
}
$('check').onclick=()=>send('check');
$('form').addEventListener('submit',event=>{event.preventDefault();send('submit');});
