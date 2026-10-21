/** Mastra user signals can have a generic notification type; metadata is canonical. */
export function isTurnUserMessage(message: any): boolean {
 if(message?.role==='user')return true;
 if(message?.role!=='signal')return false;
 const type=message.content?.metadata?.signal?.type??message.type;
 return type==='user'||type==='user-message';
}
