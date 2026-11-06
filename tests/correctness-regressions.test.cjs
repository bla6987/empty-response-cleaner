const fs = require('node:fs');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const path = require('node:path');
const source = fs.readFileSync(path.join(__dirname, '..', 'index.js'), 'utf8');
function setup(chat = [{is_user:true,mes:'Hello'}]) {
 const timers=new Map(), calls=[],deletions=[],warnings=[];let nextId=0, serialized=0, serializations=0;
 const context={chatId:'chat',characterId:1,chat,extensionSettings:{'empty-response-cleaner':{enabled:true,autoDelete:true,retryOnApiError:true,maxRetries:1,retryDelayMs:250}}};
 const document={body:{dataset:{}}};
 context.generate=async type=>calls.push(type);
 context.deleteMessage=async (id,swipeIndex)=>{deletions.push({id,swipeIndex});if(swipeIndex===undefined){context.chat.splice(id,1);return;}const m=context.chat[id],old=m.swipe_id;m.swipes.splice(swipeIndex,1);m.swipe_info?.splice(swipeIndex,1);if(swipeIndex<old)m.swipe_id--;else if(swipeIndex===old){m.swipe_id=Math.min(swipeIndex,m.swipes.length-1);m.mes=m.swipes[m.swipe_id];}};
 const countedJSON={parse:JSON.parse,stringify(...args){const s=JSON.stringify(...args);serializations++;serialized+=(s?.length??0);return s;}};
 const sandbox=vm.createContext({SillyTavern:{getContext:()=>context},jQuery:()=>{},console,URL,Response,Headers,TextDecoder,JSON:countedJSON,document,window:{location:{href:'http://localhost:8000/'}},fetch:async()=>Response.json({error:{message:'<none>'}}),toastr:{info(){},warning:t=>warnings.push(t)},setTimeout:cb=>{timers.set(++nextId,cb);return nextId;},clearTimeout:id=>timers.delete(id),requestAnimationFrame:cb=>cb()});
 vm.runInContext(source,sandbox);vm.runInContext('installFetchInterceptor()',sandbox);
 const run=s=>vm.runInContext(s,sandbox);
 const flush=async()=>{for(let i=0;i<5;i++)await new Promise(setImmediate);};
 const request=()=>sandbox.fetch('/api/backends/chat-completions/generate',{body:JSON.stringify({stream:false})});
 const fire=async()=>{assert.equal(timers.size,1);const [id,cb]=timers.entries().next().value;timers.delete(id);await cb();await flush();};
 return {context,document,timers,calls,deletions,warnings,run,request,fire,flush,counts:()=>({serializations,serialized})};
}
(async()=>{
 // Verified host group lifecycle: outer Generate then member Generate.
 const a=setup();a.context.groupId='group';
 a.context.generate=async(type)=>{a.calls.push(type);a.run(`onGenerationStarted(${JSON.stringify(type)})`);a.run("onGenerationStarted('normal')");await a.request();};
 a.run("onGenerationStarted('normal')");await a.request();
 await a.fire(); assert.equal(a.calls.length,1); assert.equal(a.timers.size,0); assert(a.warnings.some(x=>/limit reached/.test(x)));
 // Non-streaming core awaits chat persistence before clearing generating flag.
 const b=setup([{is_user:true,mes:'Hello'},{is_user:false,mes:'',swipes:[''],swipe_id:0}]);
 b.document.body.dataset.generating='true';b.run("onGenerationStarted('normal')");b.run("onCharacterMessageRendered(1, 'normal')");await b.fire();
 delete b.document.body.dataset.generating;await b.fire();assert.equal(b.context.chat.length,1);assert.equal(b.deletions.length,1);assert.equal(b.timers.size,0);
 console.log('Cleanup: empty normal reply remains after busy-at-50ms timer; no follow-up after idle');
 // A failed ordinary continuation leaves its original response unchanged.
 const c=setup([{is_user:true,mes:'Hello'},{is_user:false,mes:'Existing reply',swipes:['Existing reply'],swipe_id:0}]);
 c.run("onGenerationStarted('continue')");await c.request();assert.equal(c.timers.size,1);await c.fire();assert.deepEqual(c.calls,['continue']);assert(!c.warnings.some(x=>/existing message/.test(x)));
 console.log('Continuation: transient error schedules retry, then cancels unchanged valid response as would-delete');
 // Bounded allocation work in current cleanup, including ownership safety checks.
 const d=setup([{is_user:true,mes:'Hello'},{is_user:false,mes:'keep',swipes:['keep',...Array(100).fill('')],swipe_id:0,extra:{reasoning:'r'.repeat(10000)}}]);
 await d.run('processLastMessage(true)');assert.equal(d.deletions.length,100);assert.equal(d.context.chat[1].swipes.length,1);
 console.log('100-empty-swipe cleanup:',JSON.stringify(d.counts()));
})().catch(e=>{console.error(e);process.exitCode=1;});
