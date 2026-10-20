import {test} from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';
const source=readFileSync(new URL('./control.mjs',import.meta.url),'utf8');
const start=source.indexOf('async function loadPersonReferenceMetadata(){');
const end=source.indexOf('\nfor(const scene of scenes){',start);
const metadataFunction=source.slice(start,end);
test('transient reference lookup failure retries after cooldown, not as permanent missing',async()=>{
 const context=vm.createContext({URLSearchParams,clock:0,Date:{now:()=>context.clock},document:{querySelectorAll:()=>[{value:'["photo-id"]'}]}});
 vm.runInContext(`const personReferenceCatalog=new Map(),requestedPersonReferences=new Set();let personReferenceFetching=false,personReferenceRetryAt=0;let calls=0;const referenceIds=input=>JSON.parse(input.value);const renderPersonReferences=()=>{};let json=async()=>{calls++;throw Error('503');};`+metadataFunction,context);
 await vm.runInContext('loadPersonReferenceMetadata()',context);
 assert.equal(vm.runInContext('personReferenceCatalog.has("photo-id")',context),false);
 await vm.runInContext('loadPersonReferenceMetadata()',context);
 assert.equal(vm.runInContext('calls',context),1);
 context.clock=5001;
 vm.runInContext('json=async()=>{calls++;return {items:[{id:"photo-id",imageUrl:"/captures/face.png"}],missingIds:[]};};',context);
 await vm.runInContext('loadPersonReferenceMetadata()',context);
 assert.equal(vm.runInContext('calls',context),2);
 assert.equal(vm.runInContext('personReferenceCatalog.get("photo-id").imageUrl',context),'/captures/face.png');
});
test('only explicitly missing reference IDs receive the unavailable placeholder',async()=>{
 const context=vm.createContext({URLSearchParams,Date,document:{querySelectorAll:()=>[{value:'["missing-id"]'}]}});
 vm.runInContext(`const personReferenceCatalog=new Map(),requestedPersonReferences=new Set();let personReferenceFetching=false,personReferenceRetryAt=0;const referenceIds=input=>JSON.parse(input.value);const renderPersonReferences=()=>{};const json=async()=>({items:[],missingIds:['missing-id']});`+metadataFunction,context);
 await vm.runInContext('loadPersonReferenceMetadata()',context);
 assert.equal(vm.runInContext('personReferenceCatalog.get("missing-id").missing',context),true);
});
