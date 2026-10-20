/** Server-synthesized Japanese extras already have their final display text.
 * Translating their temporary English description is discarded work.
 */
export function displayTranslationSubset(items:string[],overrides:ReadonlyMap<number,string>) {
 const indices=items.map((_,i)=>i).filter(i=>!overrides.has(i));
 return {items:indices.map(i=>items[i]),indices,
  restore(translated:unknown[]):string[]{
   if(translated.length!==indices.length)throw Error('item count mismatch');
   return items.map((text,i)=>overrides.get(i)??(String(translated[indices.indexOf(i)]??'').trim()||text));
  }};
}
