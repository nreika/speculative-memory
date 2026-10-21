// Tiny dependency-free markdown to HTML for the authoring guide (headings, lists, tables, code, bold, inline code, links, quotes).
export const escapeHtml=s=>String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
function inline(text){
  const codes=[];
  let t=escapeHtml(text).replace(/`([^`]+)`/g,(_,c)=>{codes.push(c);return '\u0000'+(codes.length-1)+'\u0000';});
  t=t.replace(/\*\*([^*]+)\*\*/g,'<strong>$1</strong>');
  t=t.replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g,'<a href="$2" rel="noopener">$1</a>');
  return t.replace(/\u0000(\d+)\u0000/g,(_,i)=>'<code>'+codes[Number(i)]+'</code>');
}
const slug=s=>s.toLowerCase().replace(/[^a-z0-9぀-ヿ一-鿿]+/g,'-').replace(/^-|-$/g,'');
const LIST=/^(\s*)([-*]|\d+\.)\s+(.*)$/;
const BLOCK=/^(```|#{1,6}\s|\s*\||\s*>|\s*([-*]|\d+\.)\s)/;
export function markdownToHtml(md){
  const lines=String(md).replace(/\r\n?/g,'\n').split('\n');const out=[];let i=0;
  const cells=l=>l.trim().replace(/^\|/,'').replace(/\|$/,'').split('|').map(c=>c.trim());
  while(i<lines.length){
    const line=lines[i];
    if(/^```/.test(line)){const buf=[];i++;while(i<lines.length&&!/^```/.test(lines[i]))buf.push(lines[i++]);i++;out.push('<pre><code>'+escapeHtml(buf.join('\n'))+'</code></pre>');continue;}
    const h=/^(#{1,6})\s+(.*)$/.exec(line);
    if(h){out.push(`<h${h[1].length} id="${slug(h[2])}">${inline(h[2])}</h${h[1].length}>`);i++;continue;}
    if(/^\s*\|/.test(line)&&i+1<lines.length&&/^\s*\|?\s*:?-{2,}/.test(lines[i+1])){
      const head=cells(line);i+=2;const rows=[];while(i<lines.length&&/^\s*\|/.test(lines[i]))rows.push(cells(lines[i++]));
      out.push('<div class="tw"><table><thead><tr>'+head.map(c=>'<th>'+inline(c)+'</th>').join('')+'</tr></thead><tbody>'+rows.map(r=>'<tr>'+r.map(c=>'<td>'+inline(c)+'</td>').join('')+'</tr>').join('')+'</tbody></table></div>');continue;}
    if(/^\s*>/.test(line)){const buf=[];while(i<lines.length&&/^\s*>/.test(lines[i]))buf.push(lines[i++].replace(/^\s*>\s?/,''));out.push('<blockquote>'+inline(buf.join(' '))+'</blockquote>');continue;}
    const li=LIST.exec(line);
    if(li){const ordered=/\d/.test(li[2]);const items=[];
      while(i<lines.length){const m=LIST.exec(lines[i]);if(m){items.push([m[1].length,m[3]]);i++;}else if(/^\s+\S/.test(lines[i])&&items.length){items[items.length-1][1]+=' '+lines[i].trim();i++;}else break;}
      out.push((ordered?'<ol>':'<ul>')+items.map(([d,t])=>`<li${d>=2?' class="sub"':''}>${inline(t)}</li>`).join('')+(ordered?'</ol>':'</ul>'));continue;}
    if(!line.trim()){i++;continue;}
    const buf=[];while(i<lines.length&&lines[i].trim()&&!BLOCK.test(lines[i]))buf.push(lines[i++]);
    if(!buf.length)buf.push(lines[i++]);
    out.push('<p>'+inline(buf.join(' '))+'</p>');
  }
  return out.join('\n');
}
export function guidePage(md,info){
  const v=info?.version?'v'+info.version:'';const d=info?.date||'';
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="dark"><meta name="robots" content="noindex"><title>Scenario Authoring Guide ${escapeHtml(v)}</title><link rel="stylesheet" href="guide.css"></head><body><header class="bar"><strong>Scenario Authoring Guide</strong><span class="ver" title="${escapeHtml(d)}">${escapeHtml(v)}${d?' · '+escapeHtml(d):''}</span><a class="dl" href="guide.md" download="SCENARIO-AUTHORING-GUIDE.md">Download .md</a></header><main>${markdownToHtml(md)}</main></body></html>`;
}
