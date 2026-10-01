/** One thin absorbing card material, shared by source, medium and surface. */
export const CARD_TRANSPORT_WGSL = /* wgsl */ `
// The measured DOM rectangle is the front face at z=0. Thickness extends away
// from the viewer. Optical depth is an authored material property, not a floor.
const CARD_THICKNESS:f32=0.032;
const CARD_OPTICAL_DEPTH:f32=2.1;
fn cardCoverage(p:vec2f,softness:f32)->f32 {
  let aspect=scene.viewport.x/scene.viewport.y;
  var coverage=0.0;
  for(var j=0u;j<min(10u,u32(max(0.0,light.optics.w)));j++){
    let r=light.cards[j];
    if(r.z<=0.0 || r.w<=0.0){continue;}
    let size=r.zw*vec2f(aspect,1.0);
    let center=(r.xy+r.zw*0.5-0.5)*vec2f(aspect,1.0);
    let radius=min(8.0/scene.viewport.y,min(size.x,size.y)*0.1);
    let q=abs(p-center)-size*0.5+radius;
    let sd=length(max(q,vec2f(0.0)))+min(max(q.x,q.y),0.0)-radius;
    coverage=max(coverage,1.0-smoothstep(-softness,softness,sd));
  }
  return coverage;
}
fn cardPathTransmission(origin:vec3f,destination:vec3f,softness:f32)->f32 {
  let ray=destination-origin;
  if(abs(ray.z)<0.000001){return 1.0;}
  let a=(0.0-origin.z)/ray.z;
  let b=(CARD_THICKNESS-origin.z)/ray.z;
  let enter=max(0.0,min(a,b));
  let leave=min(1.0,max(a,b));
  if(leave<=enter){return 1.0;}
  let p=mix(origin,destination,(enter+leave)*0.5);
  let footprint=length(ray.xy)*(leave-enter)*0.25;
  let coverage=cardCoverage(p.xy,max(0.5/scene.viewport.y,softness)+footprint);
  let opticalDepth=CARD_OPTICAL_DEPTH*length(ray)*(leave-enter)/CARD_THICKNESS;
  return mix(1.0,exp(-opticalDepth),coverage);
}
// A finite image of the emitter. Each pixel has its own view path through the
// material, so an edge can cover part of the halo without switching it all off.
fn directSourceRadiance(uv:vec2f,cloudTransmission:f32)->vec3f {
  let aspect=scene.viewport.x/scene.viewport.y;
  let d=(uv-light.source.xy)*vec2f(aspect,1.0);
  let r=length(d);let px=1.0/scene.viewport.y;
  let extent=1.0-smoothstep(9.0*px,14.0*px,r);
  let point=exp(-pow(r/(px*2.35),2.0))*extent;
  let halo=exp(-r/(px*3.4))*0.14*extent;
  let sparkle=(exp(-abs(d.x)/(px*0.32)-abs(d.y)/(px*4.4))
    +exp(-abs(d.y)/(px*0.32)-abs(d.x)/(px*4.4)))*0.11*extent;
  let night=vec3f(1.0,0.955,0.855)*(point+halo+sparkle);
  let dusk=vec3f(0.92,0.74,0.46)*(point+halo+sparkle);
  let dayExtent=1.0-smoothstep(0.10,0.14,r);
  let day=vec3f(1.0,0.86,0.62)*(exp(-r*r/(0.022*0.022))*0.16+exp(-r*31.0)*0.055)*dayExtent*cloudTransmission;
  let progress=clamp(scene.viewport.w,0.0,1.0);
  return mix(mix(night,dusk,smoothstep(0.0,0.5,progress)),day,smoothstep(0.5,1.0,progress))*clamp(light.source.w,0.0,2.0);
}
`;
