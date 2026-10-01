/** CPU owns only a bounded pointer history. The existing star kernel creates the wake. */
export const WAKE_SAMPLES = 24;
export const WAKE_STARS = WAKE_SAMPLES * 8;
export const WAKE_LIFETIME = 0.62;

export const STAR_WAKE_WGSL = `
  struct Wake { controls:vec4f, samples:array<vec4f,24> };
  @group(0) @binding(3) var<uniform> wake:Wake;
`;

/** Insert after ordinary stellar strength, immediately before the final 24 click stars. */
export const STAR_WAKE_INSTANCE_WGSL = `
  if(i>=u32(params.field.z)-216u && i<u32(params.field.z)-24u){
    let local=i-(u32(params.field.z)-216u);
    let segment=local/8u;
    let count=u32(wake.controls.y);
    strength=0.0;
    if(count>1u && segment+1u<count && wake.controls.z>0.5){
      let oldest=(u32(wake.controls.x)+24u-count)%24u;
      let a=wake.samples[(oldest+segment)%24u];
      let b=wake.samples[(oldest+segment+1u)%24u];
      let along=(f32(local%8u)+hash(n+121.0))*0.125;
      let age=max(0.0,params.viewport.z-mix(a.z,b.z,along));
      let fade=1.0-smoothstep(0.0,0.62,age);
      let jitter=vec2f(hash(n+123.0)-0.5,hash(n+124.0)-0.5)*(0.018+age*0.014);
      // Inverse of the z=0 projection keeps the wake exactly under the pointer.
      let compensation=vec2f(params.pointer.x*0.16,-params.pointer.y*0.115-params.pointer.w*0.36);
      p=vec3f(mix(a.xy,b.xy,along)+jitter+compensation,0.0);
      halfSize=0.95+hash(n+126.0)*0.65;
      strength=(0.32+hash(n+127.0)*0.48)*fade*fade*b.w;
      // Wake speckles have their own mild shimmer, independent of the Milky Way.
      strength*=0.88+0.12*sin(params.viewport.z*3.0+n*2.17);
    }
  }
`;

export function createStarWake(device: GPUDevice) {
  // meta = [next-write index, sample count, wake enabled, reduced-motion accent].
  // Each sample is [world x, world y, scene time, intensity]. Exactly 400 bytes.
  const data=new Float32Array(4+WAKE_SAMPLES*4);
  const buffer=device.createBuffer({label:'Star fabric / 24 pointer samples',size:data.byteLength,usage:GPUBufferUsage.UNIFORM|GPUBufferUsage.COPY_DST});
  let head=0,count=0,lastX=0,lastY=0,lastTime=-100,anchored=false;
  let pending:{x:number,y:number}|null=null;
  function put(x:number,y:number,time:number,intensity:number){
    data.set([x,y,time,intensity],4+head*4);head=(head+1)%WAKE_SAMPLES;count=Math.min(count+1,WAKE_SAMPLES);
    lastX=x;lastY=y;lastTime=time;
  }
  function clear(){head=count=0;anchored=false;pending=null;lastTime=-100;data.fill(0);}
  return {
    buffer,
    move(x:number,y:number,pointerType='mouse'){
      if(pointerType==='touch'){pending=null;anchored=false;return;}
      pending={x,y};
    },
    leave(){pending=null;anchored=false;},
    clear,
    write(time:number,enabled:boolean,reducedMotion:boolean){
      if(!enabled){clear();}
      else if(pending){
        const {x,y}=pending;pending=null;
        if(!anchored||time-lastTime>0.12){
          // Restart after a pause: never connect across an idle gap or re-entry.
          head=count=0;put(x,y,time,0);anchored=true;
        }else{
          const distance=Math.hypot(x-lastX,y-lastY);
          if(distance>0.004&&time-lastTime>=0.008)put(x,y,time,Math.min(1,distance/0.024));
        }
      }
      data.set([head,count,enabled?1:0,reducedMotion?1:0]);device.queue.writeBuffer(buffer,0,data);
    },
    destroy(){clear();buffer.destroy();},
  };
}
