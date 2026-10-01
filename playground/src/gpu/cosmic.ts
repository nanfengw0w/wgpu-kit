import type { DepthLightState, LightSurface } from '../depth-light';
import { createCardLightRenderer } from './card-light';
import { DAWN_ATMOSPHERE_WGSL } from './dawn-atmosphere';
import { LIGHT_APERTURE_WGSL } from './light-aperture';
import { CARD_TRANSPORT_WGSL } from './card-transport';
import { bindSkyInput } from '../sky-input';
import { createStarWake, STAR_WAKE_WGSL, STAR_WAKE_INSTANCE_WGSL } from './star-wake';
import { Buffer, GpuContext, PingPong, elementKernel, rawKernel } from 'wgpu-kit';

type Theme = 'dark' | 'light';

/** Crisp, directly rendered stars, displaced by a gently relaxing local GPU drift field. */
export async function mountStarFabric(canvas: HTMLCanvasElement, onStatus: (text: string) => void = () => {}, options: { reducedMotion?: boolean; theme?: Theme; interactionTarget?: HTMLElement } = {}) {
  const ctx = await GpuContext.get(), device = ctx.device;
  const context = canvas.getContext('webgpu');
  if (!context) throw new Error('WebGPU canvas unavailable');
  const format = navigator.gpu.getPreferredCanvasFormat();
  context.configure({ device, format, alphaMode: 'opaque' });
  const GW = 160, GH = 80, COUNT = 48000;
  const fabric = await PingPong.create({ displacement: 'vec4f', velocity: 'vec4f' }, GW * GH);
  const stars = await Buffer.create('vec4f', COUNT * 2);
  const depthParams = device.createBuffer({ size: 192, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
  let depthState: DepthLightState = {source:[0.73,0.23,2.1,1.1],cards:[],focus:0.46,pageProgress:0,cameraDistance:2.6,reducedMotion:!!options.reducedMotion};
  const depthData = new Float32Array(48);
  const params = device.createBuffer({ size: 64, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
  const paramData = new Float32Array(16);
  const wake = createStarWake(device);
  const finePointer = window.matchMedia?.('(any-pointer: fine)').matches ?? true;
  const step = elementKernel({
    name: 'Star fabric / directional local drift',
    state: { nextD: 'vec4f', nextV: 'vec4f' }, inputs: { oldD: 'vec4f', oldV: 'vec4f' },
    uniforms: { grid: 'vec2u', dt: 'f32', grab: 'vec2f', tug: 'vec2f', pressed: 'f32', aspect: 'f32', hover: 'vec2f', flow: 'vec2f' },
    code: `
      fn userFn(i:u32, grid:vec2u, dt:f32, grab:vec2f, tug:vec2f, pressed:f32, aspect:f32, hover:vec2f, flow:vec2f) {
        let x = i % grid.x; let y = i / grid.x;
        if (x == 0u || y == 0u || x + 1u == grid.x || y + 1u == grid.y) { nextD[i]=vec4f(0.0); nextV[i]=vec4f(0.0); return; }
        let d = oldD[i].xyz;
        let rest = vec2f((f32(x)/f32(grid.x-1u)-0.5)*9.2, (0.5-f32(y)/f32(grid.y-1u))*4.8);
        let distance = length(rest-grab);
        let weight = exp(-distance*distance/0.18) * pressed;
        // Local drag remains first-order, with no spring or Z puff.
        // 0.18 world units is about 3.8% of the viewport height.
        let cap = vec2f(0.18*min(aspect,1.0),0.18);
        let drag = clamp((tug-grab)*0.50,-cap,cap)*weight;
        let hoverWeight = exp(-dot(rest-hover,rest-hover)/0.22)*(1.0-pressed);
        let hoverDrift = clamp(flow*0.13,-cap*0.45,cap*0.45)*hoverWeight;
        // A held press gathers only this small patch; there is no spring state.
        let gather = (grab-rest)*0.36*weight;
        let wanted = vec3f(clamp(drag+gather+hoverDrift,-cap,cap),0.0);
        // On release every component relaxes monotonically to zero.
        let rate = select(1.8,10.0,pressed>0.5);
        let alpha = 1.0-exp(-rate*dt/60.0);
        let next = mix(d,wanted,alpha);
        nextD[i] = vec4f(next,0.0);
        nextV[i] = vec4f((next-d)/max(dt,0.00001),0.0);
      }
    `,
  });
  const sharedWGSL = `
    struct Params { viewport:vec4f, pointer:vec4f, field:vec4f, pulse:vec4f };
    fn hash(x:f32)->f32 { var u=bitcast<u32>(x);u^=u>>16u;u*=0x7feb352du;u^=u>>15u;u*=0x846ca68bu;u^=u>>16u;return f32(u)/4294967296.0; }
    fn normalRandom(a:f32,b:f32)->f32 { return sqrt(-2.0*log(max(a,0.00001)))*cos(6.2831853*b); }
    fn bandPoint(t:f32, strand:f32, aspect:f32)->vec3f {
      let narrow = min(1.0, aspect/1.25);
      let y = 0.50*sin(t*2.3)+t*0.60 + strand*0.035 + 0.025*sin(t*19.0+strand*2.0);
      return vec3f(t*3.8*narrow, y + select(0.0,0.42,aspect<0.9),0.35*sin(t*2.0));
    }
  `;
  const updateStars = rawKernel(sharedWGSL + STAR_WAKE_WGSL + `
    @group(0) @binding(0) var<storage,read> field:array<vec4f>;
    @group(0) @binding(1) var<storage,read_write> instances:array<vec4f>;
    @group(0) @binding(2) var<uniform> params:Params;
    fn displace(p:vec3f)->vec3f {
      let uv = clamp(vec2f(p.x/9.2+0.5,0.5-p.y/4.8),vec2f(0.0),vec2f(0.999));
      let s = uv*(params.field.xy-1.0); let a=vec2u(s); let f=fract(s); let w=u32(params.field.x);
      return mix(mix(field[a.y*w+a.x].xyz,field[a.y*w+a.x+1u].xyz,f.x),mix(field[(a.y+1u)*w+a.x].xyz,field[(a.y+1u)*w+a.x+1u].xyz,f.x),f.y);
    }
    @compute @workgroup_size(64)
    fn main(@builtin(global_invocation_id) gid:vec3u) {
      let i=gid.x; if(i>=u32(params.field.z)){return;}
      let n=f32(i)+1.0; let a=hash(n); let b=hash(n+917.3); let c=hash(n+272.9); let d=hash(n+503.7);
      let t=a*2.0-1.0;
      let inBand=b<0.73;
      let strand=floor(hash(n+7.0)*3.0)-1.0;
      var p=bandPoint(t,strand,params.field.w);
      let gaussian=normalRandom(c,d);
      let offset=gaussian*(0.07+0.085*hash(n+29.0));
      p.y += offset;
      p.z += normalRandom(hash(n+31.0),hash(n+32.0))*0.26;
      if(!inBand){
        p=vec3f((a-0.5)*11.0*(params.field.w/1.65),(c-0.5)*6.7,-1.0-hash(n+61.0)*4.0);
      }
      let movement=displace(p)*select(0.22,1.0,inBand);
      p+=movement;
      let rare=hash(n+71.0);
      let large=pow(rare,600.0)*select(1.0,0.78,inBand);
      var halfSize=1.1+large*7.8;
      let twinkle=0.72+0.28*sin(params.viewport.z*(0.42+hash(n+87.0)*1.3)+n*1.723);
      let heat=hash(n+51.0);
      let tint=mix(vec3f(0.54,0.73,1.0),vec3f(1.0,0.80,0.52),heat);
      let white=mix(tint,vec3f(1.0),0.40);
      let knots=exp(-pow((t+0.58)/0.20,2.0))+0.90*exp(-pow((t-0.20)/0.16,2.0))+0.75*exp(-pow((t-0.74)/0.12,2.0));
      let dustLine=0.035*sin(t*8.0+0.8)+0.022*sin(t*23.0);
      let dust=0.88*exp(-pow((offset-dustLine)/(0.015+0.006*sin(t*6.0)),2.0));
      let density=clamp(0.23+knots*0.67,0.20,0.97)*(1.0-dust);
      let present=select(1.0,select(0.0,1.0,hash(n+95.0)<density),inBand);
      let pulseAge=params.viewport.z-params.pulse.z;
      // Click feedback is confined to the last 24 stars, never a travelling ring.
      var strength=(0.050+0.086*hash(n+98.0)+large*3.5)*twinkle*select(0.73,1.0,inBand)*present;
      ${STAR_WAKE_INSTANCE_WGSL}
      // A brief constellation burst also makes clicks in empty sky legible.
      // These are crisp GPU star instances, not a screen-sized rubber ring.
      if(i+24u>=u32(params.field.z)){
        let age=max(0.0,pulseAge);let angle=6.2831853*hash(n+102.0);
        let reduced=wake.controls.w>0.5;
        let radial=(0.028+0.115*hash(n+103.0))*(1.0+age*0.08);
        let compensation=vec2f(params.pointer.x*0.16,-params.pointer.y*0.115-params.pointer.w*0.36);
        p=vec3f(params.pulse.xy+vec2f(cos(angle),sin(angle))*radial+compensation,0.0);
        let burstActive=params.pulse.w*select(0.0,1.0,pulseAge>=0.0);
        strength=burstActive*exp(-age*4.0)*(0.7+hash(n+104.0)*0.5)*select(1.0,0.55,reduced);
        halfSize=select(1.35+exp(-age*4.0)*0.65,1.35,reduced);
      }
      instances[i*2u]=vec4f(p,halfSize);
      instances[i*2u+1u]=vec4f(white*strength,rare);
    }
  `, 'main', 'Star fabric / individual stellar instances');
  await Promise.all([step.prepare(),updateStars.prepare()]);

  const renderSource = sharedWGSL + `
    @group(0) @binding(0) var<storage,read> stars:array<vec4f>;
    @group(0) @binding(1) var<uniform> params:Params;
    @group(0) @binding(2) var<storage,read> field:array<vec4f>;
    fn project(p:vec3f)->vec4f {
      let px=p.x-params.pointer.x*(0.16+p.z*0.034);
      let py=p.y+params.pointer.y*(0.115+p.z*0.025)+params.pointer.w*(0.36+p.z*0.045);
      let depth=5.5-p.z;
      let scale=2.0/tan(0.72);
      return vec4f(px*scale/params.field.w,py*scale,depth*0.98,depth);
    }
    struct StarOut { @builtin(position) position:vec4f, @location(0) uv:vec2f, @location(1) color:vec3f, @location(2) size:f32 };
    @vertex fn starVS(@builtin(vertex_index) vertex:u32,@builtin(instance_index) i:u32)->StarOut {
      let corners=array<vec2f,6>(vec2f(-1.0,-1.0),vec2f(1.0,-1.0),vec2f(-1.0,1.0),vec2f(-1.0,1.0),vec2f(1.0,-1.0),vec2f(1.0,1.0));
      let p=stars[i*2u]; let col=stars[i*2u+1u]; var clip=project(p.xyz);
      let halfSize=p.w*min(params.viewport.x/1440.0+0.45,1.5);
      clip.x+=corners[vertex].x*halfSize*2.0/params.viewport.x*clip.w;
      clip.y+=corners[vertex].y*halfSize*2.0/params.viewport.y*clip.w;
      var out:StarOut;out.position=clip;out.uv=corners[vertex];out.color=col.rgb;out.size=halfSize;return out;
    }
    @fragment fn starFS(in:StarOut)->@location(0) vec4f {
      let p=in.uv*in.size;let r2=dot(p,p);
      let core=exp(-r2/0.24);
      let halo=exp(-r2/max(0.5,in.size*in.size*0.15))*0.00030*max(in.size-1.0,0.0);
      let glint=(exp(-abs(p.x)*8.0)*exp(-abs(p.y)*0.60)+exp(-abs(p.y)*8.0)*exp(-abs(p.x)*0.60))*0.035*max(in.size-2.0,0.0);
      return vec4f(in.color*(core+halo+glint),1.0);
    }
    fn getDisplacement(p:vec3f)->vec3f {
      let uv=clamp(vec2f(p.x/9.2+0.5,0.5-p.y/4.8),vec2f(0.0),vec2f(0.999));
      let s=uv*(params.field.xy-1.0);let a=vec2u(s);let f=fract(s);let w=u32(params.field.x);
      return mix(mix(field[a.y*w+a.x].xyz,field[a.y*w+a.x+1u].xyz,f.x),mix(field[(a.y+1u)*w+a.x].xyz,field[(a.y+1u)*w+a.x+1u].xyz,f.x),f.y);
    }
    struct LineOut { @builtin(position) position:vec4f, @location(0) color:vec3f };
    @vertex fn lineVS(@builtin(vertex_index) id:u32)->LineOut {
      let trace=id/512u; let segment=(id%512u)/2u;let endpoint=id%2u;
      let t=(f32(segment+endpoint)/256.0)*2.0-1.0;
      let p=bandPoint(t,f32(trace)-1.0,params.field.w);
      let d=getDisplacement(p);let neighbor=getDisplacement(p+vec3f(0.03,0.0,0.0));
      let strain=length(d-neighbor);
      let fade=smoothstep(0.009,0.045,strain)*smoothstep(0.035,0.13,length(d));
      var out:LineOut;out.position=project(p+d);out.color=vec3f(0.025,0.061,0.095)*fade;return out;
    }
    @fragment fn lineFS(in:LineOut)->@location(0) vec4f{return vec4f(in.color,1.0);}
  `;
  const module = device.createShaderModule({label:'Star fabric / crisp instanced stars + strained filaments',code:renderSource});
  const bindLayout = device.createBindGroupLayout({entries:[
    {binding:0,visibility:GPUShaderStage.VERTEX,buffer:{type:'read-only-storage'}},
    {binding:1,visibility:GPUShaderStage.VERTEX|GPUShaderStage.FRAGMENT,buffer:{type:'uniform'}},
    {binding:2,visibility:GPUShaderStage.VERTEX,buffer:{type:'read-only-storage'}},
  ]});
  const layout=device.createPipelineLayout({bindGroupLayouts:[bindLayout]});
  const additive:GPUBlendState={color:{srcFactor:'one',dstFactor:'one',operation:'add'},alpha:{srcFactor:'one',dstFactor:'one',operation:'add'}};
  const starPipeline=await device.createRenderPipelineAsync({layout,vertex:{module,entryPoint:'starVS'},fragment:{module,entryPoint:'starFS',targets:[{format:'rgba16float',blend:additive}]},primitive:{topology:'triangle-list'}});
  const linePipeline=await device.createRenderPipelineAsync({layout,vertex:{module,entryPoint:'lineVS'},fragment:{module,entryPoint:'lineFS',targets:[{format:'rgba16float',blend:additive}]},primitive:{topology:'line-list'}});
  const bindingsFor=(buffer:GPUBuffer)=>device.createBindGroup({layout:bindLayout,entries:[{binding:0,resource:{buffer:stars.gpuBuffer}},{binding:1,resource:{buffer:params}},{binding:2,resource:{buffer}}]});
  const fieldBindings=new Map<GPUBuffer,GPUBindGroup>([[fabric.current.displacement.gpuBuffer,bindingsFor(fabric.current.displacement.gpuBuffer)],[fabric.other.displacement.gpuBuffer,bindingsFor(fabric.other.displacement.gpuBuffer)]]);
  const presentModule=device.createShaderModule({label:'Star fabric / continuous perspective depth light',code:`// One point emitter, perspective eye rays, and actual card-plane occlusion.
// World origin is the screen center. Camera=(0,0,-cameraDistance), cards z=0.
// Source.xy is its projected UV, NOT its world-space position.
@group(0) @binding(0) var image:texture_2d<f32>;
struct Scene { viewport:vec4f, pointer:vec4f, field:vec4f, pulse:vec4f };
@group(0) @binding(1) var<uniform> scene:Scene;
struct DepthLight { source:vec4f, cards:array<vec4f,10>, optics:vec4f };
@group(0) @binding(2) var<uniform> light:DepthLight;

@vertex fn vs(@builtin(vertex_index) i:u32)->@builtin(position)vec4f {
  let x=f32((i<<1u)&2u);let y=f32(i&2u);
  return vec4f(x*2.0-1.0,y*2.0-1.0,0.0,1.0);
}

// Fixed 3D particulate layers supply depth variation, rather than a moving mask.
fn densityAt(p:vec3f)->f32 {
  let a=sin(dot(p,vec3f(4.7,-6.1,2.8))+0.6);
  let b=sin(dot(p,vec3f(-7.1,-2.2,5.3))+2.2);
  let c=sin(dot(p,vec3f(1.7,9.1,-4.7))-0.9);
  let strata=pow(max(0.0,0.48+0.25*a+0.17*b+0.10*c),2.0);
  return 0.055+strata*0.62;
}

// Three unequal emitter apertures make source-to-surface paths legible.
// They are smooth angular distributions around the SAME emitter, never
// independent screen-space lights or an evenly spaced radial spoke pattern.
${LIGHT_APERTURE_WGSL}
${DAWN_ATMOSPHERE_WGSL}
${CARD_TRANSPORT_WGSL}

// x=total scattering, y=near scattering, z=occluded energy.
// Eight eye-side samples plus four behind the card plane give actual depth.
// Far medium is camera-occluded; near medium is emitter-occluded.
fn scattering(uv:vec2f)->vec3f {
  let aspect=scene.viewport.x/scene.viewport.y;
  let camera=max(1.0,light.optics.z);
  let depth=max(0.25,light.source.z);
  let source=sourcePosition(light.source,aspect,camera);
  let srcXY=source.xy;
  let rayXY=(uv-0.5)*vec2f(aspect,1.0);
  let rayDir=normalize(vec3f(rayXY,camera));
  let range=min(1.88,camera*0.76);
  let dz=range/8.0;
  let farRange=depth*0.84;
  let eye=vec3f(0.0,0.0,-camera);
  var radiance=vec3f(0.0);
  for(var i=0u;i<12u;i++){
    let front=i<8u;
    let t=select((f32(i)-8.0+0.5)/4.0,(f32(i)+0.5)/8.0,front);
    let z=select(0.025+t*farRange,-0.025-t*range,front);
    let p=vec3f(rayXY*(camera+z)/camera,z);
    let toward=source-p;
    let d2=dot(toward,toward);
    // Derivative of this perspective ray's crossing with the card plane.
    // It integrates the entire depth-slice footprint, suppressing stair steps.
    let derivative=depth*(rayXY*(camera+depth)/camera-srcXY)/(toward.z*toward.z);
    let footprint=length(derivative)*dz*0.56;
    let penumbra=0.00065+(-z/depth)*0.0022+footprint;
    let incoming=cardPathTransmission(source,p,penumbra);
    let outgoing=cardPathTransmission(p,eye,1.0/scene.viewport.y);
    let transmission=incoming*outgoing;
    let blocked=1.0-transmission;
    let cosine=clamp(dot(normalize(toward),rayDir),0.0,1.0);
    let g=select(0.55,0.69,front);
    let phase=(1.0-g*g)/pow(1.0+g*g-2.0*g*cosine,1.5);
    let slope=beamSlope(p,source,camera);
    let angular=aperture(slope);
    let extinction=select(exp(-0.24*(1.0+t)),exp(-0.46*t),front);
    let falloff=(depth*depth+0.20)/(d2+0.20);
    let cloudTransmission=dawnSharedTransmission(p,source,light.source,scene.viewport,scene.pointer,camera);
    let energy=densityAt(p)*phase*angular*falloff*extinction*select(1.75,1.0,front)*cloudTransmission;
    let stepLength=select(farRange/4.0,dz,front);
    let nearWeight=select(0.08,t,front);
    radiance+=vec3f(energy*transmission,energy*transmission*nearWeight,energy*blocked)*stepLength;
  }
  return radiance/(range+farRange*0.7);
}

@fragment fn fs(@builtin(position) p:vec4f)->@location(0)vec4f {
  let params=scene.viewport;
  let uv=p.xy/params.xy;
  let aspect=params.x/params.y;
  let progress=clamp(params.w,0.0,1.0);
  let focus=clamp(light.optics.x,0.45,1.0);
  let intensity=clamp(light.source.w,0.0,2.0);
  let energy=textureLoad(image,vec2i(p.xy),0).rgb;
  let quiet=mix(0.68,1.0,smoothstep(0.12,0.66,uv.x));
  let nightBase=pow(vec3f(0.00014,0.00022,0.00040)/vec3f(0.80),vec3f(1.0/2.2));
  let dark=pow((energy*quiet+vec3f(0.00014,0.00022,0.00040))/(energy*quiet+vec3f(0.80)),vec3f(1.0/2.2));
  let stars=max(dark-nightBase,vec3f(0.0));
  let delta=(uv-light.source.xy)*vec2f(aspect,1.0);
  let radial=length(delta);
  let px=1.0/params.y;
  // No focus threshold: the hero, intermediate gaps and lower home share volume.
  let volume=scattering(uv)*intensity*mix(0.66,1.0,focus);
  let shaft=1.0-exp(-volume.x*0.85);
  let nearShaft=1.0-exp(-volume.y*1.2);
  let shadow=1.0-exp(-volume.z*0.48);
  let camera=max(1.0,light.optics.z);
  let source=sourcePosition(light.source,aspect,camera);
  let eye=vec3f(0.0,0.0,-camera);
  let emitterSample=vec3f((uv-0.5)*vec2f(aspect,1.0)*(camera+source.z)/camera,source.z);
  let emitterVisibility=cardPathTransmission(eye,emitterSample,px);
  let directCloud=dawnSharedTransmission(eye,source,light.source,scene.viewport,scene.pointer,camera);
  let lower=smoothstep(-0.08,1.04,uv.y);
  let localAir=exp(-radial*3.4);
  // Near scattering is warm and stronger; far atmosphere stays blue.
  var night=nightBase+vec3f(0.011,0.025,0.055)*(0.25+localAir*0.46);
  night+=vec3f(0.33,0.228,0.095)*shaft+vec3f(0.052,0.023,0.003)*nearShaft;
  // Authored high-altitude dawn: remote cloud sheet, clear copy space,
  // warm air below cool air, and a source partially veiled by that same sheet.
  var day=night;
  if(progress>0.0){
  let cloud=dawnCloudDensity(uv,light.source,scene.viewport,scene.pointer);
  let cloudAlpha=1.0-exp(-cloud*1.75);
  let skyHeight=smoothstep(-0.16,1.07,uv.y);
  day=mix(vec3f(0.443,0.564,0.685),vec3f(0.978,0.921,0.843),skyHeight);
  // Broad forward-scattered aureole, no disc, edge, or spherical shading.
  let haze=exp(-radial*7.0)*0.23*intensity;
  day=mix(day,vec3f(1.0,0.944,0.822),haze);
  let nearSun=exp(-radial*10.0);
  let thin=smoothstep(0.0,1.50,cloud);
  let cloudTexture=dawnNoise(uv*vec2f(61.0,197.0)+vec2f(8.0,3.0));
  let cloudUnder=mix(vec3f(0.883,0.884,0.857),vec3f(0.794,0.823,0.835),thin)+cloudTexture*0.020;
  let cloudLit=mix(cloudUnder,vec3f(0.991,0.900,0.755),nearSun*0.24);
  let edgeGlow=pow(max(0.0,cloudAlpha*(1.0-cloudAlpha)),1.25)*2.8*nearSun;
  let cloudColor=cloudLit+vec3f(0.06,0.047,0.025)*edgeGlow;
  day=mix(day,cloudColor,cloudAlpha*0.94);
  // Both the warm volume and receiving-card overlay use the cloud-plane
  // transmission along the actual path from this identical finite emitter.
  day+=vec3f(0.065,0.047,0.024)*shaft+vec3f(0.021,0.016,0.008)*nearShaft;
  day-=vec3f(0.010,0.008,0.004)*shadow;
  let mist=dawnNearMist(uv,scene.viewport,scene.pointer);
  day=mix(day,vec3f(0.97,0.927,0.865),mist);
  }
  // Reversible dusk waypoint, continuous value and first derivative at .5.
  var dusk=mix(vec3f(0.080,0.123,0.207),vec3f(0.254,0.235,0.272),lower);
  dusk+=vec3f(0.24,0.126,0.045)*shaft+vec3f(0.057,0.027,0.007)*nearShaft;
  let starVisibility=1.0-smoothstep(0.04,0.72,progress);
  var color=mix(mix(night,dusk,smoothstep(0.0,0.5,progress)),day,smoothstep(0.5,1.0,progress))+stars*starVisibility;
  color+=directSourceRadiance(uv,directCloud)*emitterVisibility;
  // Existing projected click feedback is retained through every theme state.
  let age=max(0.0,params.z-scene.pulse.z);
  let scale=2.0/tan(0.72);
  let pulseUV=vec2f(0.5+scene.pulse.x*scale/(5.5*aspect)*0.5,0.5-scene.pulse.y*scale/5.5*0.5);
  let q=(uv-pulseUV)*vec2f(aspect,1.0);
  let glimmer=(exp(-abs(q.x)*750.0)*exp(-abs(q.y)*75.0)+exp(-abs(q.y)*750.0)*exp(-abs(q.x)*75.0));
  let accent=scene.pulse.w*exp(-age*3.1)*min(1.0,glimmer)*0.85;
  color=mix(color,vec3f(1.0,0.85,0.57),accent*smoothstep(0.0,1.0,progress));
  return vec4f(clamp(color,vec3f(0.0),vec3f(1.0)),1.0);
}
`});
  const presentPipeline=await device.createRenderPipelineAsync({layout:'auto',vertex:{module:presentModule,entryPoint:'vs'},fragment:{module:presentModule,entryPoint:'fs',targets:[{format}]}});

  const cardLight=await createCardLightRenderer(device,params,depthParams,format);
  let texture:GPUTexture|undefined,presentBindings:GPUBindGroup|undefined,pixelW=0,pixelH=0;
  let destroyed=false,paused=false,motionOverride=false,visible=true,frame=0,previous=0,time=8,announced=false;
  let theme:Theme=options.theme??'dark';
  let themeBlend=theme==='light'?1:0,themeTarget=themeBlend,externalTheme=false;
  let targetX=0,targetY=0,pointerX=0,pointerY=0,lastInteraction=-Infinity;
  let grabbed=false,grabX=0,grabY=0,mouseX=0,mouseY=0;
  let flowX=0,flowY=0;
  let pulse={x:0,y:0,z:-100,w:0};
  const abort=new AbortController(),signal=abort.signal;
  function requestFrame(){if(!frame&&!destroyed&&visible&&!document.hidden)frame=requestAnimationFrame(draw);}
  function point(clientX:number,clientY:number,pointerType='mouse'){
    const r=canvas.getBoundingClientRect(),oldX=mouseX,oldY=mouseY;
    targetX=(clientX-r.left)/Math.max(1,r.width)*2-1;targetY=(clientY-r.top)/Math.max(1,r.height)*2-1;
    const scale=5.5*Math.tan(0.72)/2;mouseX=targetX*(r.width/r.height)*scale;mouseY=-targetY*scale;
    if(!grabbed){flowX=Math.max(-1,Math.min(1,(mouseX-oldX)*4));flowY=Math.max(-1,Math.min(1,(mouseY-oldY)*4));}
    wake.move(mouseX,mouseY,pointerType);
    lastInteraction=performance.now();requestFrame();
  }
  const unbindInput=bindSkyInput(options.interactionTarget??canvas,{
    move:point,
    down(x,y,pointerType){point(x,y,pointerType);grabbed=true;flowX=flowY=0;grabX=mouseX;grabY=mouseY;
      if(options.reducedMotion&&!motionOverride)pulse={x:mouseX,y:mouseY,z:time,w:1};
    },
    up(click){if(click)pulse={x:mouseX,y:mouseY,z:time,w:1};grabbed=false;flowX=flowY=0;lastInteraction=performance.now();requestFrame();},
    leave(){wake.leave();targetX=targetY=0;flowX=flowY=0;lastInteraction=performance.now();requestFrame();},
  });
  canvas.addEventListener('keydown',event=>{
    if(event.key==='ArrowLeft')targetX=Math.max(-1,targetX-0.22);
    else if(event.key==='ArrowRight')targetX=Math.min(1,targetX+0.22);
    else if(event.key==='ArrowUp')targetY=Math.max(-1,targetY-0.22);
    else if(event.key==='ArrowDown')targetY=Math.min(1,targetY+0.22);
    else if(event.key==='Enter'){if(event.repeat)return;grabbed=!grabbed;grabX=mouseX;grabY=mouseY;if(options.reducedMotion&&!motionOverride)pulse={x:mouseX,y:mouseY,z:time,w:1};}
    else if(event.key===' '){pulse={x:mouseX,y:mouseY,z:time,w:1};}
    else if(event.key.toLowerCase()==='r'){event.preventDefault();reset();return;}else return;
    const r=canvas.getBoundingClientRect(),s=5.5*Math.tan(0.72)/2;mouseX=targetX*r.width/r.height*s;mouseY=-targetY*s;event.preventDefault();lastInteraction=performance.now();requestFrame();
  },{signal});
  const releaseInteraction=()=>{unbindInput.cancel();grabbed=false;flowX=flowY=0;wake.clear();previous=0;requestFrame();};
  canvas.addEventListener('blur',releaseInteraction,{signal});
  window.addEventListener('blur',releaseInteraction,{signal});
  document.addEventListener('visibilitychange',()=>{previous=0;if(document.hidden){releaseInteraction();if(frame)cancelAnimationFrame(frame);frame=0;}else requestFrame();},{signal});
  let renderRect=canvas.getBoundingClientRect();
  const resizeObserver=new ResizeObserver(()=>{renderRect=canvas.getBoundingClientRect();requestFrame();});resizeObserver.observe(canvas);
  const intersectionObserver=new IntersectionObserver(entries=>{visible=entries[0]?.isIntersecting??true;previous=0;if(!visible){releaseInteraction();if(frame)cancelAnimationFrame(frame);frame=0;}else requestFrame();});intersectionObserver.observe(canvas);
  const gpuError=(event:GPUUncapturedErrorEvent)=>{event.preventDefault();paused=true;onStatus(`WebGPU error: ${event.error.message}`);};device.addEventListener('uncapturederror',gpuError);
  ctx.lost.then(info=>{if(!destroyed){paused=true;onStatus(`WebGPU device lost: ${info.message||info.reason}`);}});

  let lastCardAnimation=0,lastStatusTheme=-1;
  function draw(now:number){frame=0;if(destroyed||document.hidden||!visible)return;
    try{
      const r=renderRect,dpr=Math.min(window.devicePixelRatio||1,1.5,Math.sqrt(2073600/Math.max(1,r.width*r.height)));const w=Math.max(1,Math.round(r.width*dpr)),h=Math.max(1,Math.round(r.height*dpr));
      if(w!==pixelW||h!==pixelH){canvas.width=pixelW=w;canvas.height=pixelH=h;cardLight.invalidate();texture?.destroy();texture=device.createTexture({size:[w,h],format:'rgba16float',usage:GPUTextureUsage.RENDER_ATTACHMENT|GPUTextureUsage.TEXTURE_BINDING});presentBindings=device.createBindGroup({layout:presentPipeline.getBindGroupLayout(0),entries:[{binding:0,resource:texture.createView()},{binding:1,resource:{buffer:params,offset:0,size:64}},{binding:2,resource:{buffer:depthParams,offset:0,size:192}}]});}
      const dt=previous?Math.min((now-previous)/1000,0.025):1/60;previous=now;
      if(!externalTheme&&themeBlend!==themeTarget)cardLight.invalidate();
      if(!externalTheme){themeBlend=options.reducedMotion?themeTarget:themeBlend+(themeTarget-themeBlend)*(1-Math.exp(-3.8*dt));if(Math.abs(themeBlend-themeTarget)<.001)themeBlend=themeTarget;}
      const motionAllowed=!options.reducedMotion||motionOverride;
      const running=!paused&&motionAllowed;if(running)time+=dt;
      const follow=running?0.13:0;pointerX+=(targetX-pointerX)*follow;pointerY+=(targetY-pointerY)*follow;
      wake.write(time,running&&finePointer,!motionAllowed);
      depthData.fill(0);depthData.set(depthState.source,0);depthState.cards.slice(0,10).forEach((rect,index)=>depthData.set(rect,4+index*4));depthData.set([depthState.focus,depthState.reducedMotion?1:0,depthState.cameraDistance,Math.min(10,depthState.cards.length)],44);device.queue.writeBuffer(depthParams,0,depthData);
      paramData.set([w,h,time,themeBlend,pointerX,pointerY,grabbed?1:0,depthState.pageProgress,GW,GH,COUNT,w/h,pulse.x,pulse.y,pulse.z,pulse.w]);device.queue.writeBuffer(params,0,paramData);
      const enc=device.createCommandEncoder({label:'Star fabric: gentle drift → stellar instances → crisp native quads'});
      step.encode(enc,{nextD:fabric.other.displacement,nextV:fabric.other.velocity,oldD:fabric.current.displacement,oldV:fabric.current.velocity},{grid:{x:GW,y:GH},dt:running?dt*60:0,grab:{x:grabX,y:grabY},tug:{x:mouseX,y:mouseY},pressed:grabbed?1:0,aspect:w/h,hover:{x:mouseX,y:mouseY},flow:{x:flowX,y:flowY}});fabric.swap();flowX*=Math.exp(-8*dt);flowY*=Math.exp(-8*dt);
      if(themeBlend<0.72)updateStars.encode(enc,[{binding:0,resource:{buffer:fabric.current.displacement.gpuBuffer}},{binding:1,resource:{buffer:stars.gpuBuffer}},{binding:2,resource:{buffer:params}},{binding:3,resource:{buffer:wake.buffer}}],Math.ceil(COUNT/64));
      const pass=enc.beginRenderPass({colorAttachments:[{view:texture!.createView(),clearValue:{r:0,g:0,b:0,a:0},loadOp:'clear',storeOp:'store'}]});if(themeBlend<0.72){pass.setBindGroup(0,fieldBindings.get(fabric.current.displacement.gpuBuffer)!);pass.setPipeline(starPipeline);pass.draw(6,COUNT);pass.setPipeline(linePipeline);pass.draw(256*2*3);}pass.end();
      const screen=enc.beginRenderPass({colorAttachments:[{view:context!.getCurrentTexture().createView(),loadOp:'clear',storeOp:'store',clearValue:{r:0,g:0,b:0,a:1}}]});screen.setPipeline(presentPipeline);screen.setBindGroup(0,presentBindings!);screen.draw(3);screen.end();const animateCards=running&&themeBlend>0&&now-lastCardAnimation>66;if(animateCards)lastCardAnimation=now;cardLight.draw(enc,w,h,dpr,animateCards);device.queue.submit([enc.finish()]);step.endSubmit();
      const statusTheme=themeBlend>.72?1:0;if(!announced||lastStatusTheme!==statusTheme){announced=true;lastStatusTheme=statusTheme;onStatus(statusTheme?'Live WebGPU · Dawn atmosphere':`Live WebGPU · ${COUNT.toLocaleString()} individual stars`);}
      if(running||(!externalTheme&&themeBlend!==themeTarget))requestFrame();
    }catch(error){paused=true;step.endSubmit();onStatus(`WebGPU: ${error instanceof Error?error.message:String(error)}`);}
  }
  const zero=new Float32Array(GW*GH*4);
  function reset(){unbindInput.cancel();wake.clear();for(const side of [fabric.current,fabric.other]){side.displacement.write(zero);side.velocity.write(zero);}grabbed=false;targetX=targetY=pointerX=pointerY=mouseX=mouseY=grabX=grabY=flowX=flowY=0;time=8;previous=0;lastInteraction=-Infinity;pulse={x:0,y:0,z:-100,w:0};requestFrame();}
  requestFrame();
  return{
    destroy(){if(destroyed)return;destroyed=true;if(frame)cancelAnimationFrame(frame);abort.abort();resizeObserver.disconnect();intersectionObserver.disconnect();device.removeEventListener('uncapturederror',gpuError);unbindInput();wake.destroy();texture?.destroy();cardLight.destroy();depthParams.destroy();params.destroy();stars.destroy();fabric.destroy();step.destroy();updateStars.destroy();context.unconfigure();},
    setPaused(value:boolean){paused=value;if(!value)motionOverride=true;else releaseInteraction();previous=0;requestFrame();},
    setDepthLight(value:DepthLightState,surfaces:LightSurface[]=[]){depthState=value;cardLight.update(surfaces);requestFrame();},
    reset,setTheme(value:Theme){theme=value;themeTarget=value==='light'?1:0;cardLight.invalidate();requestFrame();},setThemeProgress(value:number){externalTheme=true;themeBlend=Math.max(0,Math.min(1,value));cardLight.invalidate();requestFrame();},
  };
}

export const mountCosmos = mountStarFabric;
