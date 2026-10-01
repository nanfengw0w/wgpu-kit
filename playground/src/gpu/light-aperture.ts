/** Shared emitter geometry for volume scattering and card back-side illumination. */
export const LIGHT_APERTURE_WGSL = /* wgsl */ `
fn finiteLobe(q:f32)->f32 {
  return exp(-q*q)*(1.0-smoothstep(2.5,3.5,abs(q)));
}
fn beamAperture(slope:vec2f)->f32 {
  let r=length(slope);
  let a=finiteLobe(dot(slope,vec2f(0.45,0.893))/(0.002+r*0.078))
    *smoothstep(-0.005,0.025,dot(slope,vec2f(-0.893,0.45)));
  let b=finiteLobe(dot(slope,vec2f(0.96,-0.28))/(0.0025+r*0.17))
    *smoothstep(-0.005,0.030,dot(slope,vec2f(0.28,0.96)));
  let c=finiteLobe(dot(slope,vec2f(-0.31,0.951))/(0.0015+r*0.11))
    *smoothstep(-0.005,0.024,dot(slope,vec2f(-0.951,-0.31)));
  return 1.55*a+0.92*b+0.72*c;
}
fn aperture(slope:vec2f)->f32 {
  // Diffuse medium baseline does not illuminate the card surfaces.
  return 0.035+beamAperture(slope);
}
fn sourcePosition(projected:vec4f,aspect:f32,camera:f32)->vec3f {
  return vec3f((projected.xy-0.5)*vec2f(aspect,1.0)*(camera+projected.z)/camera,projected.z);
}
fn beamSlope(point:vec3f,source:vec3f,camera:f32)->vec2f {
  return (point.xy-source.xy)/(source.z-point.z)+source.xy/(source.z+camera);
}
`;
