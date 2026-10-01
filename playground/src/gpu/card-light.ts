import type { LightSurface } from '../depth-light';
import { LIGHT_APERTURE_WGSL } from './light-aperture';
import { DAWN_ATMOSPHERE_WGSL } from './dawn-atmosphere';
import { CARD_TRANSPORT_WGSL } from './card-transport';

/** Same rear emitter as the sky: bounded transmission, not front-face specular. */
export const CARD_LIGHT_WGSL = /* wgsl */ `
struct Scene { viewport:vec4f, pointer:vec4f, field:vec4f, pulse:vec4f };
struct DepthLight { source:vec4f, cards:array<vec4f,10>, optics:vec4f };
struct Surface { rect:vec4f, size:vec4f };
@group(0) @binding(0) var<uniform> scene:Scene;
@group(0) @binding(1) var<uniform> light:DepthLight;
@group(0) @binding(2) var<uniform> surface:Surface;
${LIGHT_APERTURE_WGSL}
${DAWN_ATMOSPHERE_WGSL}
${CARD_TRANSPORT_WGSL}
@vertex fn vs(@builtin(vertex_index) i:u32)->@builtin(position)vec4f {
  return vec4f(f32((i<<1u)&2u)*2.0-1.0,f32(i&2u)*2.0-1.0,0.0,1.0);
}
@fragment fn fs(@builtin(position) pixel:vec4f)->@location(0)vec4f {
  let local=pixel.xy/surface.size.xy;
  let uv=surface.rect.xy+local*surface.rect.zw;
  let aspect=scene.viewport.x/scene.viewport.y;
  let camera=max(1.0,light.optics.z);
  let source=sourcePosition(light.source,aspect,camera);
  let point=vec3f((uv-0.5)*vec2f(aspect,1.0),0.0);
  let incident=source-point;
  let distance2=dot(incident,incident);
  let cosine=source.z/sqrt(distance2);
  let beam=beamAperture(beamSlope(point,source,camera));
  // This is the visible front face. Light from behind traverses the receiver's
  // thickness, using exactly the same optical depth as the surrounding volume.
  let materialTransmission=cardPathTransmission(source,point,0.5/scene.viewport.y);
  let cloudTransmission=dawnSharedTransmission(point,source,light.source,scene.viewport,scene.pointer,camera);
  let energy=max(0.0,light.source.w)*beam*cosine*(source.z*source.z+0.20)/(distance2+0.20)*cloudTransmission*materialTransmission;
  let dpr=surface.size.z;
  let edge=min(pixel.xy,surface.size.xy-pixel.xy)/dpr;
  let direction=normalize(incident.xy+vec2f(0.000001));
  let edgeFacing=max(
    max((1.0-smoothstep(0.0,2.0,edge.x))*max(0.0,select(-direction.x,direction.x,local.x>0.5)),
        (1.0-smoothstep(0.0,2.0,edge.y))*max(0.0,select(-direction.y,direction.y,local.y>0.5))),0.0);
  let alpha=min(0.24,(1.0-exp(-energy*0.22))*(0.70+edgeFacing*0.80));
  // No sheen stripe or ambient floor. Outside the beam the overlay is exactly
  // transparent, so original card color, opacity and thumbnails are unchanged.
  let tint=mix(vec3f(1.0,0.82,0.51),vec3f(1.0,0.87,0.62),scene.viewport.w);
  let eye=vec3f(0.0,0.0,-camera);
  let emitterSample=vec3f((uv-0.5)*vec2f(aspect,1.0)*(camera+source.z)/camera,source.z);
  let directTransmission=cardPathTransmission(eye,emitterSample,0.5/scene.viewport.y);
  let directCloud=dawnSharedTransmission(eye,source,light.source,scene.viewport,scene.pointer,camera);
  let direct=directSourceRadiance(uv,directCloud)*directTransmission;
  let rgb=tint*alpha+direct*(1.0-alpha);
  // Premultiplied bounded emission; outside beam and finite source footprint,
  // all channels remain exactly zero and the original material is untouched.
  return vec4f(rgb,max(alpha,max(rgb.r,max(rgb.g,rgb.b))));
}
`;

type Target = { context: GPUCanvasContext; uniform: GPUBuffer; binding: GPUBindGroup };
export async function createCardLightRenderer(device: GPUDevice, scene: GPUBuffer, light: GPUBuffer, format: GPUTextureFormat) {
  const module=device.createShaderModule({label:'Card light / shared beam, finite transmission',code:CARD_LIGHT_WGSL});
  const pipeline=await device.createRenderPipelineAsync({layout:'auto',vertex:{module,entryPoint:'vs'},fragment:{module,entryPoint:'fs',targets:[{format}]}});
  const targets=new Map<HTMLCanvasElement,Target>();
  let surfaces:LightSurface[]=[],dirty=true;
  function release(canvas:HTMLCanvasElement,target:Target){target.context.unconfigure();target.uniform.destroy();targets.delete(canvas);}
  return {
    update(next:LightSurface[]){surfaces=next;dirty=true;const keep=new Set(next.map(x=>x.canvas));for(const [canvas,target] of targets)if(!keep.has(canvas))release(canvas,target);},
    invalidate(){dirty=true;},
    draw(encoder:GPUCommandEncoder,width:number,height:number,dpr:number,animate=false){
      // Cloud drift changes transmission without DOM geometry changes.
      // The parent can pass animate=false when paused/reduced-motion.
      if(!dirty&&!animate)return;dirty=false;
      for(const item of surfaces){
        const canvas=item.canvas;let target=targets.get(canvas);
        if(!target){
          const context=canvas.getContext('webgpu');if(!context)continue;
          context.configure({device,format,alphaMode:'premultiplied'});
          const uniform=device.createBuffer({size:32,usage:GPUBufferUsage.UNIFORM|GPUBufferUsage.COPY_DST});
          const binding=device.createBindGroup({layout:pipeline.getBindGroupLayout(0),entries:[{binding:0,resource:{buffer:scene}},{binding:1,resource:{buffer:light}},{binding:2,resource:{buffer:uniform}}]});
          target={context,uniform,binding};targets.set(canvas,target);
        }
        const w=Math.max(1,Math.round(item.rect[2]*width)),h=Math.max(1,Math.round(item.rect[3]*height));
        if(canvas.width!==w)canvas.width=w;if(canvas.height!==h)canvas.height=h;
        device.queue.writeBuffer(target.uniform,0,new Float32Array([...item.rect,w,h,dpr,0]));
        const pass=encoder.beginRenderPass({label:'Localized card transmission',colorAttachments:[{view:target.context.getCurrentTexture().createView(),loadOp:'clear',storeOp:'store',clearValue:{r:0,g:0,b:0,a:0}}]});
        pass.setPipeline(pipeline);pass.setBindGroup(0,target.binding);pass.draw(3);pass.end();
      }
    },
    destroy(){for(const [canvas,target] of targets)release(canvas,target);surfaces=[];},
  };
}
