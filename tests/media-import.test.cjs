/* File picker metadata can arrive before a finite duration, especially on phones. */
const {test}=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs'),path=require('node:path');
const {File}=require('node:buffer');
function setup({duration=1,late=false,error=false}={}) {
  const players=[],revoked=[];
  const window={EchoCore:require('../core.js')};
  const document={body:{append(p){players.push(p);}},createElement(){
    return {style:{},duration:late?Infinity:duration,setAttribute(){},pause(){},removeAttribute(){},remove(){this.removed=true;},
      load(){if(this.loaded)return;this.loaded=true;setTimeout(()=>{
        if(error)this.onerror?.();else {this.onloadedmetadata?.();if(late)setTimeout(()=>{this.duration=duration;this.ondurationchange?.();},5);}
      },0);}
    };
  }};
  vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../media.js'),'utf8'),{window,document,URL:{createObjectURL:()=>"blob:test",revokeObjectURL:u=>revoked.push(u)},setTimeout,clearTimeout,setInterval,clearInterval});
  return {media:window.EchoMedia,players,revoked};
}
test('an untyped picker video is normalised and waits for late duration metadata',async()=>{
 const x=setup({late:true,duration:2});
 const result=await x.media.prepareClip(new File(['fixture'],'IMG_1234.MOV',{type:''}),'video');
 assert.equal(result.type,'video/quicktime');
 assert.ok(x.players.every(p=>p.removed));assert.equal(x.revoked.length,1);
});
test('late metadata does not bypass the clip duration limit',async()=>{
 const x=setup({late:true,duration:45});
 await assert.rejects(x.media.prepareClip(new File(['fixture'],'clip.mp4',{type:'application/octet-stream'}),'video'),/45 seconds.*30 seconds/);
 assert.ok(x.players.every(p=>p.removed));assert.equal(x.revoked.length,1);
});
test('unsupported actual media still fails and releases the metadata player',async()=>{
 const x=setup({error:true});
 await assert.rejects(x.media.prepareClip(new File(['not video'],'clip.mp4',{type:''}),'video'),/cannot open/);
 assert.ok(x.players.every(p=>p.removed));assert.equal(x.revoked.length,1);
});
