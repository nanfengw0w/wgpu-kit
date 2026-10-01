/** Stylized high-altitude cloud sheet shared by the sky and receiving cards.
 * This is an authored optical-depth model, not a full physical atmosphere.
 * One finite plane behind every card; source-to-point intersections use the
 * same projected emitter, aspect ratio, camera, time, and pointer/scroll map.
 */
export const DAWN_ATMOSPHERE_WGSL = /* wgsl */ `
fn dawnAmount(theme:f32)->f32 { return smoothstep(0.0,0.85,theme); }
fn dawnHash(p:vec2f)->f32 {
  var q=fract(vec3f(p.xyx)*vec3f(0.1031,0.1030,0.0973));
  q+=dot(q,q.yzx+33.33);
  return fract((q.x+q.y)*q.z);
}
fn dawnNoise(p:vec2f)->f32 {
  let a=floor(p); let f=fract(p); let w=f*f*(3.0-2.0*f);
  return mix(mix(dawnHash(a),dawnHash(a+vec2f(1.0,0.0)),w.x),
             mix(dawnHash(a+vec2f(0.0,1.0)),dawnHash(a+vec2f(1.0)),w.x),w.y);
}
fn dawnPlane(depth:f32)->f32 { return depth*0.84; }
fn dawnMap(world:vec2f,z:f32,aspect:f32,camera:f32)->vec2f {
  return world*camera/(camera+z)/vec2f(aspect,1.0)+0.5;
}
// Two bounded noise frequencies; no raymarch or nested noise loop.
// Main bank enters from the right, leaving the copy area on the left clear.
fn dawnCloudDensity(uv:vec2f,projected:vec4f,viewport:vec4f,view:vec4f)->f32 {
  let aspect=viewport.x/viewport.y;
  var q=(uv-projected.xy)*vec2f(aspect,1.0);
  q.x+=viewport.z*0.00075;
  q.y+=view.w*0.012;
  let broad=dawnNoise(q*vec2f(6.1,18.0)+vec2f(4.7,7.3));
  let fine=dawnNoise(q*vec2f(23.0,74.0)+vec2f(18.0,4.0));
  let grain=broad*0.72+fine*0.28;
  let center=0.022+0.030*sin(q.x*5.2)+0.030*(broad-0.5);
  let width=(0.017+0.033*smoothstep(-0.13,0.48,q.x))*(0.60+grain*0.95);
  let body=exp(-pow((q.y-center)/width,2.0));
  let entrance=smoothstep(-0.19,-0.025,q.x);
  let broken=smoothstep(0.15,0.68,grain);
  let bank=body*entrance*(0.035+broken*1.24);
  let filamentY=-0.108-q.x*0.045+(broad-0.5)*0.016;
  let filament=exp(-pow((q.y-filamentY)/0.0045,2.0))
    *smoothstep(-0.48,-0.26,q.x)*(1.0-smoothstep(0.2,0.72,q.x))*broken*0.22;
  let remoteY=0.43+q.x*0.065+(broad-0.5)*0.04;
  let remote=exp(-pow((q.y-remoteY)/0.026,2.0))
    *(1.0-smoothstep(-0.34,0.35,q.x))*broken*0.13;
  return bank+filament+remote;
}
fn dawnPathTransmission(point:vec3f,source:vec3f,projected:vec4f,
                        viewport:vec4f,view:vec4f,camera:f32)->f32 {
  let plane=dawnPlane(source.z);
  // A receiver behind the cloud plane has not yet crossed this medium.
  if(point.z>=plane){return 1.0;}
  let t=(plane-point.z)/(source.z-point.z);
  let crossing=mix(point.xy,source.xy,t);
  let uv=dawnMap(crossing,plane,viewport.x/viewport.y,camera);
  let density=dawnCloudDensity(uv,projected,viewport,view);
  let slant=length(source-point)/max(0.001,source.z-point.z);
  return exp(-density*2.35*min(slant,2.0));
}
fn dawnSharedTransmission(point:vec3f,source:vec3f,projected:vec4f,
                          viewport:vec4f,view:vec4f,camera:f32)->f32 {
  if(viewport.w<=0.0){return 1.0;}
  return mix(1.0,dawnPathTransmission(point,source,projected,viewport,view,camera),dawnAmount(viewport.w));
}
fn dawnNearMist(uv:vec2f,viewport:vec4f,view:vec4f)->f32 {
  let aspect=viewport.x/viewport.y;
  var q=(uv-0.5)*vec2f(aspect,1.0);
  // Thin nearer sheet moves faster under scroll, with a very small local tug.
  q.y+=view.w*0.065;
  q.x-=viewport.z*0.0011;
  let pointer=vec2f(view.x,-view.y)*vec2f(aspect,1.0)*0.5;
  let distance=q-pointer;
  q+=view.xy*exp(-dot(distance,distance)*24.0)*0.004;
  let n=dawnNoise(q*vec2f(4.0,18.0)+vec2f(14.0,8.0));
  let ridge=0.33+0.065*sin(q.x*3.4)+(n-0.5)*0.026;
  let ribbon=exp(-pow((q.y-ridge)/0.030,2.0));
  let edges=smoothstep(0.15,0.67,abs(q.x));
  return ribbon*edges*(0.12+0.12*n);
}
`;
