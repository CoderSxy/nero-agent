import {renderHook,act,waitFor} from '@testing-library/react';
import {afterEach,it,expect,vi} from 'vitest';
import {useReconciledChatMessages} from './use-reconciled-chat-messages';
const load=vi.hoisted(()=>vi.fn());vi.mock('./thread-scope',()=>({loadScopedThread:load}));
afterEach(()=>vi.clearAllMocks());
const m=(id:string,text:string)=>({id,role:'assistant',content:{format:2,parts:[{type:'text',text}]}} as any);
it('syncs after termination and rejects a response from a previous thread',async()=>{
 let resolve!:(v:any)=>void;load.mockImplementationOnce(()=>new Promise(r=>resolve=r)).mockResolvedValue({messages:[]});
 const messages=[m('a','done')];
 const {result,rerender}=renderHook(p=>useReconciledChatMessages(p),{initialProps:{messages,isRunning:true,threadId:'one',resourceId:'user'}});
 rerender({messages,isRunning:false,threadId:'one',resourceId:'user'});expect(load).toHaveBeenCalledTimes(1);
 rerender({messages:[m('b','new')],isRunning:false,threadId:'two',resourceId:'user'});
 await act(async()=>resolve({messages:[m('a','done')]}));expect(result.current[0].id).toBe('b');
});
it('keeps live text if history has not caught up, then accepts a complete snapshot',async()=>{
 const old=[m('f','old')],live=[m('f','done')];load.mockResolvedValueOnce({messages:old}).mockResolvedValue({messages:live});
 const {result,rerender}=renderHook(p=>useReconciledChatMessages(p),{initialProps:{messages:live,isRunning:true,threadId:'one',resourceId:'user'}});
 rerender({messages:live,isRunning:false,threadId:'one',resourceId:'user'});
 expect((result.current[0].content.parts[0] as {text:string}).text).toBe('done');
 await waitFor(()=>expect(load).toHaveBeenCalledTimes(2));expect(result.current).toEqual(live);
});
