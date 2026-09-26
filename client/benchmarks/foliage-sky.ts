import * as T from 'three';
import { skyGradient } from '../src/graphics/sunSky';

export function createBenchmarkSky(renderer:T.WebGLRenderer):T.WebGLRenderTarget {
  const gradient=skyGradient('#c3d2e2');
  // Match the city sky's three-color diffuse illumination without its visible dome.
  const skyScene=new T.Scene();const skyGeometry=new T.SphereGeometry(10,16,8);
  const skyMaterial=new T.ShaderMaterial({side:T.BackSide,uniforms:{zenith:{value:new T.Color(gradient.zenith)},horizon:{value:new T.Color(gradient.horizon)},ground:{value:new T.Color(gradient.ground)}},
    vertexShader:'varying vec3 d; void main(){ d=position; gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.0); }',
    fragmentShader:'varying vec3 d; uniform vec3 zenith,horizon,ground; void main(){ float y=normalize(d).y; vec3 c=mix(horizon,zenith,pow(max(y,0.0),0.55)); c=mix(c,ground,smoothstep(0.0,0.18,-y)); gl_FragColor=vec4(c,1.0); }'});
  skyScene.add(new T.Mesh(skyGeometry,skyMaterial));
  const pmrem=new T.PMREMGenerator(renderer),environment=pmrem.fromScene(skyScene);
  skyGeometry.dispose();skyMaterial.dispose();pmrem.dispose();
  return environment;
}
