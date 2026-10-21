import test from 'node:test';import assert from 'node:assert/strict';
import {createProgressState,recordToolOutcome,decideNextStep,progressFromMessages} from '../src/mastra/agents/run-progress';
const failure=(id:string,extra={})=>({toolCallId:id,toolName:'edit',target:'thread:a.html',version:'v1',argsFingerprint:'old-block',errorCode:'AMBIGUOUS_MATCH',success:false,...extra});
test('repeated same-state failures recover then finalize, duplicate events do not count twice',()=>{
 const s=createProgressState();recordToolOutcome(s,failure('1'));recordToolOutcome(s,failure('1'));assert.equal(decideNextStep(s,false,0),'continue');
 recordToolOutcome(s,failure('2'));assert.equal(decideNextStep(s,false,0),'recover');recordToolOutcome(s,failure('3'));assert.equal(decideNextStep(s,false,0),'finalize');
});
test('a new version or successful mutation resets the target failure streak',()=>{
 const s=createProgressState();recordToolOutcome(s,failure('1'));recordToolOutcome(s,failure('2'));recordToolOutcome(s,failure('3',{version:'v2'}));assert.equal(decideNextStep(s,false,0),'continue');
 recordToolOutcome(s,failure('4',{success:true,errorCode:undefined}));assert.equal(decideNextStep(s,false,0),'continue');assert.equal(decideNextStep(createProgressState(),false,90),'continue');assert.equal(decideNextStep(createProgressState(),true,7),'finalize');
});
test('restores only current user turn outcomes, including failed invocations after resume',()=>{
 const msg=(role:string,parts:any[])=>({role,content:{parts}});
 const failed=(id:string)=>({type:'tool-invocation',toolInvocation:{toolCallId:id,toolName:'edit',state:'output-error',errorText:'原文出现多次，无法唯一替换',args:{path:'a',expectedEtag:'e',oldText:'x'}}});
 const history=[msg('user',[]),msg('assistant',[failed('old1'),failed('old2'),failed('old3')]),msg('user',[]),msg('assistant',[failed('a'),failed('b')])];
 assert.equal(decideNextStep(progressFromMessages(history),false,0),'recover');assert.equal(decideNextStep(progressFromMessages([...history,msg('assistant',[failed('c')])]),false,0),'finalize');
});
test('signal metadata user boundaries isolate new turns even with notification message type',()=>{
 const bad=(id:string)=>({role:'assistant',content:{parts:[{type:'tool-invocation',toolInvocation:{toolCallId:id,toolName:'edit',state:'output-error',errorText:'ambiguous',args:{path:'x',oldText:'x'}}}]}});
 const history=[bad('a'),bad('b'),bad('c'),{role:'signal',type:'notification',content:{metadata:{signal:{type:'user'}},parts:[{type:'text',text:'new request'}]}}];
 assert.equal(decideNextStep(progressFromMessages(history),false,0),'continue');
});
