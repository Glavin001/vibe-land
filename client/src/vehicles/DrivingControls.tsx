import {defaultConfiguration, drivingFields, resolveDrivingSetup, serializeConfiguration, type VehicleConfiguration} from './configuration.mjs';
import {garageBuilds} from './builds.mjs';

/** Shared by the workshop and the in-drive drawer. Only edits driving values. */
export function DrivingControls({configuration,onChange:configure}:{configuration:VehicleConfiguration;onChange:(value:VehicleConfiguration)=>void}) {
  const drivingSetup=resolveDrivingSetup(configuration);
  return <section><h2>Driving feel <button aria-label="Reset driving feel" onClick={()=>configure({...configuration,driving:defaultConfiguration(configuration.model).driving})}>↺</button></h2>
        <p className="garage-note">Start with a personality. Fine-tune it below without changing your vehicle’s look.</p>
        <div className="garage-personalities">{[garageBuilds[0],...garageBuilds.slice(7)].map(build=><button key={build.id} aria-pressed={serializeConfiguration({...configuration,driving:build.configuration.driving})===serializeConfiguration(configuration)} onClick={()=>configure({...configuration,driving:{...build.configuration.driving}})}>{build.id==='buggy'?'Balanced':build.name}</button>)}</div>
        <label className="garage-select"><span>Driven wheels</span><select aria-label="Driven wheels" value={configuration.driving.drivetrain} onChange={e=>configure({...configuration,driving:{...configuration.driving,drivetrain:e.target.value as 'awd'|'fwd'|'rwd'}})}><option value="awd">AWD · All four wheels</option><option value="fwd">FWD · Front wheels</option><option value="rwd">RWD · Rear wheels</option></select></label>
        {[false,true].map(advanced=>{
          const fields=drivingFields.filter(([key])=>advanced?!['acceleration','topSpeed','springRate'].includes(key):['acceleration','topSpeed','springRate'].includes(key));
          const controls=fields.map(([key,label,min,max,step,unit])=><label className="garage-control" key={key}><span>{label}<output>{configuration.driving[key].toFixed(key==='topSpeed'?0:2)} <small>{unit}</small></output></span><input type="range" aria-label={label} min={min} max={max} step={step} value={configuration.driving[key]} onChange={e=>configure({...configuration,driving:{...configuration.driving,[key]:Number(e.target.value)}})}/></label>);
          return advanced?<details className="garage-details" key="advanced"><summary>Fine tuning · tires, brakes & steering</summary>{controls}</details>:<div key="core">{controls}</div>;
        })}
        <p className="garage-note" role="status">{Math.round(configuration.driving.topSpeed*3.6)} km/h speed setting · {drivingSetup.acceleration.toFixed(2)} m/s² drive-force setting{drivingSetup.acceleration<configuration.driving.acceleration?' (limited by driven-wheel grip)':''}.</p>
        <p className="garage-note">Softer springs absorb bumps; firmer springs reduce lean. Higher damping calms bouncing. FWD pulls through the front tires, sharing their grip with steering. RWD gives a livelier rear axle. Steering eases with speed and stays within the chassis linkage limits. Actual acceleration and speed depend on terrain and traction.</p>
        
      </section>;
}
