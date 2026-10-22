import {describe,it,expect} from 'vitest';
import {reconcileChatMessages,historyCoversLive} from './chat-message-reconciliation';
const msg=(id:string,parts:any[],role='assistant')=>({id,role,content:{format:2,parts}} as any);
const text=(text:string)=>({type:'text',text});
const tool=(id:string)=>({type:'tool-invocation',toolInvocation:{toolCallId:id,toolName:'web_search',state:'result',args:{},result:'data'}});
describe('terminal history reconciliation',()=>{
 it('replaces a cumulative final live snapshot with its persisted final steps without repeating tools',()=>{
  const history=[msg('a',[tool('search'),text('已取数')]),msg('final',[text('图表完成')])];
  const live=[history[0],msg('final',[tool('search'),text('已取数'),{type:'reasoning',reasoning:'earlier'},text('图表完成')])];
  expect(historyCoversLive(history,live)).toBe(true);
  expect(reconcileChatMessages({history,live,settled:true})).toEqual(history);
 });
 it('never drops unsaved deltas or a newly started turn',()=>{
  const history=[msg('a',[text('old')])];const live=[msg('a',[text('new')])];
  expect(historyCoversLive(history,live)).toBe(false);
  expect(reconcileChatMessages({history,live,settled:true})).toEqual(live);
  expect(reconcileChatMessages({history,live,settled:false})).toEqual(live);
 });
 it('retains distinct same-content calls and errors',()=>{
  const history=[msg('a',[tool('one'),tool('two'),text('done')])];
  expect(reconcileChatMessages({history,live:history,settled:true})[0].content.parts).toHaveLength(3);
 });
 it('preserves late memory completion markers without reviving cumulative reasoning',()=>{
  const history=[msg('f',[text('done')])];const marker={type:'data-om-buffering-end',data:{cycleId:'one'}};
  const live=[msg('f',[{type:'reasoning',reasoning:'old'},text('done'),marker])];
  expect(reconcileChatMessages({history,live,settled:true})[0].content.parts).toEqual([text('done'),marker]);
 });
 it('rejects snapshots missing new tool results or a pending user echo',()=>{
  const h=[msg('f',[text('done')])];
  expect(historyCoversLive(h,[msg('f',[tool('new'),text('done')])])).toBe(false);
  expect(historyCoversLive(h,[...h,msg('user2',[text('again')],'user')])).toBe(false);
 });
});
it('does not replace a live terminal error with a stored pending invocation of the same id',()=>{
 const old=msg('m',[{type:'tool-invocation',toolInvocation:{toolCallId:'t',toolName:'edit',state:'call',args:{}}}]);
 const live=msg('m',[{type:'tool-invocation',toolInvocation:{toolCallId:'t',toolName:'edit',state:'output-error',args:{},errorText:'ambiguous'}}]);
 expect(historyCoversLive([old],[live])).toBe(false);expect(reconcileChatMessages({history:[old],live:[live],settled:true})).toEqual([live]);
});
it('keeps the newer task outcome when an older replay arrives',()=>{
 const outcome=(revision:number)=>({type:'data-nero-task-outcome',data:{runId:'run-1',revision,status:revision===2?'partial':'complete',verification:'verified',requirements:[]}});
 const history=[msg('f',[text('done'),outcome(2)])];
 const live=[msg('f',[text('done'),outcome(1)])];
 expect((reconcileChatMessages({history,live,settled:true})[0].content.parts.at(-1) as {data?:{revision?:number}}).data?.revision).toBe(2);
});
it('keeps the newer task outcome when an older replay arrives for the same run',()=>{
 const outcome=(revision:number)=>({type:'data-nero-task-outcome',data:{runId:'run-1',revision,status:revision===2?'partial':'complete',verification:'verified',requirements:[{id:'weather.condition',status:'missing'}]}});
 const history=[msg('f',[text('done'),outcome(2)])];
 const live=[msg('f',[text('done'),outcome(1)])];
 const parts=reconcileChatMessages({history,live,settled:true})[0].content.parts;
 expect((parts.find(part => part.type==='data-nero-task-outcome') as {data?:{revision?:number}} | undefined)?.data?.revision).toBe(2);
});
it('does not overwrite a newer result with an older value under the same call identity',()=>{
 const a=tool('t'),b=tool('t');b.toolInvocation.result='new';
 expect(historyCoversLive([msg('m',[a])],[msg('m',[b])])).toBe(false);
});
