import {defaultConfiguration, vehicles} from './configuration.mjs';
function edition(id, name, model, description, finish, appearance, driving) {
  const base=defaultConfiguration(model);
  return {id,name,description,configuration:{...base,finish,appearance:{...base.appearance,...appearance},driving:{...base.driving,...driving}}};
}
export const garageBuilds = [
  ...vehicles.map(v=>({id:v.id,name:v.kind,description:v.name,configuration:defaultConfiguration(v.id)})),
  edition('trail','Trail explorer','buggy','AWD · Low-speed control · Compliant suspension','#45604b',
    {body:'#b8aa82',accent:'#d7a34b',wheels:'#353a34',paint:'matte'},
    {acceleration:4,topSpeed:16,grip:1.5,springRate:.85,dampingRatio:1.1,steeringResponse:.8}),
  edition('desert','Desert runner','trophy','AWD · Fast travel · Controlled rebound','#dcb77a',
    {body:'#dcb77a',accent:'#d34827',wheels:'#30363b',paint:'matte'},
    {acceleration:7,topSpeed:34,grip:1.25,springRate:.9,dampingRatio:1.15,steeringLimit:.8}),
  edition('touge','Mountain rally','rally','AWD · Quick response · Strong brakes','#29546a',
    {body:'#e1e3d9',accent:'#329ca7',wheels:'#d1ac55',paint:'gloss'},
    {acceleration:7.5,topSpeed:30,grip:1.55,braking:1.2,springRate:1.2,steeringResponse:1.2}),
  edition('drift','Drift club','derby','RWD · Lively rear axle · Progressive steering','#634786',
    {body:'#634786',accent:'#df9dd7',wheels:'#e0ddd0',seats:'#39303e',paint:'gloss'},
    {drivetrain:'rwd',acceleration:6,topSpeed:28,grip:1.05,springRate:1.15,dampingRatio:.85,steeringResponse:.85}),
  edition('circuit','Circuit special','sprint','RWD · Firm platform · Fast steering','#b63828',
    {body:'#b63828',accent:'#ebc950',wheels:'#434649',paint:'gloss'},
    {drivetrain:'rwd',acceleration:7,topSpeed:36,grip:1.6,braking:1.2,springRate:1.35,dampingRatio:1.1,steeringResponse:1.35,steeringLimit:.8}),
];
