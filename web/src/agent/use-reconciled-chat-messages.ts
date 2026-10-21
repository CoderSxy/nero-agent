import {useEffect,useRef,useState} from 'react';
import type {MastraDBMessage} from '@mastra/core/agent/message-list';
import {loadScopedThread} from './thread-scope';
import {hasRepeatedToolIds,historyCoversLive,reconcileChatMessages} from './chat-message-reconciliation';
export function useReconciledChatMessages({messages,isRunning,threadId,resourceId}:{messages:MastraDBMessage[];isRunning:boolean;threadId:string;resourceId:string}) {
  const [snapshot,setSnapshot]=useState<{key:string;messages:MastraDBMessage[]}|null>(null);
  const key=resourceId+':'+threadId;
  const previous=useRef({key,running:isRunning});
  const latest=useRef(messages);latest.current=messages;
  const duplicate=hasRepeatedToolIds(messages);
  useEffect(()=>{
    const before=previous.current;
    previous.current={key,running:isRunning};
    if(isRunning){setSnapshot(null);return;}
    if(!(before.key===key&&before.running)&&!duplicate)return;
    let active=true;let timer:ReturnType<typeof setTimeout>|undefined;
    const sync=async(attempt:number)=>{
      try {
        const result=await loadScopedThread(threadId,resourceId);
        if(!active)return;
        const history=result.messages as MastraDBMessage[];
        if(historyCoversLive(history,latest.current)){setSnapshot({key,messages:history});return;}
      } catch { /* Keep live data on transient history failures. */ }
      if(active&&attempt<2)timer=setTimeout(()=>void sync(attempt+1),attempt===0?250:750);
    };
    void sync(0);
    return()=>{active=false;clearTimeout(timer);};
  },[key,isRunning,duplicate,threadId,resourceId]);
  return reconcileChatMessages({history:snapshot?.key===key?snapshot.messages:[],live:messages,settled:!isRunning&&snapshot?.key===key});
}
