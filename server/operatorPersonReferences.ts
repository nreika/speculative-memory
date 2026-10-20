/** Private upload IDs only. Images/paths never belong in operator settings. */
export const MAX_SCENE_PERSON_REFERENCES=15; // source image uses one of the model's 16 slots; identity refs are checked later.
export function personReferenceIds(value:unknown):string[]{
 if(value===undefined)return [];
 if(!Array.isArray(value)||value.length>MAX_SCENE_PERSON_REFERENCES||value.some(id=>typeof id!=='string'||!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(id)))throw Error('Invalid private person reference IDs');
 const ids=value.map(id=>id.toLowerCase());if(new Set(ids).size!==ids.length)throw Error('Duplicate private person reference IDs');return ids;
}
export function mergedPersonReferenceIds(continuous:unknown,oneShot:unknown):string[]{
 const ids=[...new Set([...personReferenceIds(continuous),...personReferenceIds(oneShot)])];
 if(ids.length>MAX_SCENE_PERSON_REFERENCES)throw Error('Person references exceed the model image limit');return ids;
}
